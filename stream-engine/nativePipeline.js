// ================================================================
// 🎬 NATIVE PROGRAM FEED PIPELINE — replaces the gdigrab-based
// "render camera+overlay in a browser window, screen-capture that
// window" approach with a real native pipeline that never screen/
// window-captures anything:
//
//   CAMERA (dshow, opened ONCE)
//   + OVERLAY (Chrome DevTools Protocol screencast — see
//     overlayBridge.js — reads frames straight from Chromium's
//     renderer, never from the OS screen; delivered to ffmpeg over a
//     loopback TCP socket, wall-clock paced — see OverlayPacer)
//         ↓
//   COMPOSITOR (one ffmpeg process; opens the camera exactly once)
//         ↓ relays the composited frames out its own stdout,
//           uncompressed (rawvideo/NUT)
//         ├──→ RECORDER-ENCODER (its own NVENC session) → master.mp4
//         └──→ LIVE-ENCODER (its own NVENC session) → RTMPS → YouTube
//
// WHY THIS SHAPE, SPECIFICALLY: a physical camera (unlike a browser
// window, which is a shareable OS surface) can normally only be opened
// by ONE process at a time — so recording and streaming each hold their
// own encoder downstream of ONE compositor's relay.
//
// 🔒 RELAY ISOLATION (the long-run fix — see the git history of this
// file for the three earlier attempts and why each one failed):
//
//   The relay is a NUT stream. NUT writes a SYNCPOINT (a fixed 8-byte
//   startcode + a full timestamp) in front of every packet here, and a
//   demuxer that receives [stream header][syncpoint ...] decodes
//   cleanly no matter where in the live stream that syncpoint came from
//   — it is exactly what a seek lands on. NutUnitSplitter below cuts the
//   compositor's stdout into "units" (one syncpoint + its packet) and
//   every consumer only ever receives WHOLE units:
//     - a consumer attaching late gets [header][next unit…] — a valid
//       stream starting "now", with no stale replay and no restart of
//       the compositor (the old code restarted the leg or spliced a
//       stale byte buffer into the live stream; the splice misaligned
//       the consumer's demuxer — "Invalid buffer size, packet size N <
//       expected frame_size" — and the timestamp jump made the
//       recorder's -r CFR logic duplicate MINUTES of frames, shifting
//       master.mp4's whole timeline so clips cut from it came out empty);
//     - a consumer that falls behind (writable backlog above a bound)
//       has whole units skipped instead of Node buffering the ~90 MB/s
//       relay without limit; it resumes on the next unit, the demuxer
//       sees a timestamp gap, and its -r output fills it — timeline and
//       A/V sync stay correct, memory stays bounded;
//     - detaching (Stop, restart) ends the consumer's stdin on a unit
//       boundary, so its ffmpeg never sees a truncated final packet.
//   The compositor itself never waits on a consumer: Node drains its
//   stdout unconditionally.
//
// 🩺 HEALTH: a compositor that stops producing relay data (camera
// wedged, dshow hung) is killed by its own watchdog; any unexpected exit
// ends every consumer's stdin (so they exit and restart through their
// own paths in server.js instead of hanging forever on a silent pipe —
// the old "process alive, file not growing" failure) and the compositor
// relaunches itself with backoff while anything still holds a ref.
//
// The compositor is reference-counted (addRef/removeRef): it starts the
// moment recording, streaming or the preview needs it, and server.js
// stops it once none of them does.
// ================================================================
const { EventEmitter } = require('events');
const net = require('net');
const os = require('os');
const { OverlayBridge, available: overlayBridgeAvailable } = require('./overlayBridge');

// Modest, steady rate for the overlay input — a scoreboard doesn't need
// full 30fps of its own repaint cadence; this just needs to be fast
// enough that a score change reaches the program feed without a
// noticeable delay.
const OVERLAY_FPS = 15;
// 🖥️ PROGRAM PREVIEW — what the operator actually watches in the panel.
// This used to be 2fps at 640px wide, which is a slideshow, not a monitor:
// you cannot judge framing, focus or whether the feed is live from it. It
// is decimated BEFORE scaling and encoded as plain MJPEG, so even at these
// values it costs a small fraction of what the real encode costs, and it
// is a separate filter branch — it can never slow the recording or the
// YouTube push down. Tunable for weaker machines.
const PREVIEW_FPS = Number(process.env.STREAM_ENGINE_PREVIEW_FPS) || 15;
const PREVIEW_WIDTH = Number(process.env.STREAM_ENGINE_PREVIEW_WIDTH) || 960;
// See the -rtbufsize comment in buildCompositorArgs() for why this is
// deliberately small. Raise it only if ffmpeg reports dropped frames on a
// machine you know is otherwise keeping up.
const CAMERA_RTBUFSIZE = process.env.STREAM_ENGINE_CAMERA_RTBUFSIZE || '64M';

const RELAY_CONTAINER_ARGS = ['-f', 'nut', '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2'];

// NUT's SYNCPOINT_STARTCODE (libavformat/nut.h: 0xE4ADEECA4569 + ('N'<<8|'K')<<48),
// big-endian on the wire.
const NUT_SYNCPOINT = Buffer.from([0x4E, 0x4B, 0xE4, 0xAD, 0xEE, 0xCA, 0x45, 0x69]);

// A consumer whose stdin backlog exceeds this many seconds of relay
// data starts skipping whole units; it resumes once the backlog drains
// below RELAY_RESUME_SEC. Bounds Node's memory per consumer to roughly
// RELAY_PAUSE_SEC × relay bitrate (~140 MB at 1080p30) no matter how
// long a consumer stalls.
const RELAY_PAUSE_SEC = 1.5;
const RELAY_RESUME_SEC = 0.25;

// Expected, non-actionable ffmpeg notices in this pipeline (the preview
// branch's full-range JPEG conversion triggers the swscaler one).
const BENIGN_LINE_RE = /deprecated pixel format used|Guessed Channel Layout/i;

// Compositor watchdog — see _checkHealth.
const COMPOSITOR_STARTUP_GRACE_MS = 30000; // dshow open + overlay connect can legitimately take a while
const COMPOSITOR_STALL_MS = 10000;          // no relay bytes for this long after startup = wedged
const COMPOSITOR_RELAUNCH_BACKOFF_MS = [1000, 2000, 5000, 10000];
const COMPOSITOR_STABLE_RESET_MS = 60000;   // a leg that ran this long resets the relaunch backoff

// Raises (or lowers) a child's OS scheduling priority, best effort. The
// compositor/recorder/live encoder run ABOVE_NORMAL so background work
// (clip cuts, the operator's own apps) can never starve real-time capture.
function setProcessPriority(proc, priority) {
    if (!proc || !proc.pid) return;
    try { os.setPriority(proc.pid, priority); } catch (e) { /* not permitted on this OS/user — harmless */ }
}

// ----------------------------------------------------------------
// ✂️ NUT UNIT SPLITTER — cuts a live NUT byte stream at syncpoints.
// onHeader(buf) fires once with everything before the first syncpoint
// (main/stream/info headers); onUnit(pieces, bytes) fires for every
// complete unit (a syncpoint through the byte before the next one).
// Pieces are zero-copy views of the incoming chunks. The last 7 bytes
// of each chunk are held back so a startcode split across two chunks is
// still found; a unit is only emitted once the NEXT syncpoint proves it
// is complete, so nothing downstream ever sees a partial packet.
// ----------------------------------------------------------------
class NutUnitSplitter {
    constructor({ onHeader, onUnit }) {
        this.onHeader = onHeader;
        this.onUnit = onUnit;
        this.carry = null;
        this.headerPieces = [];
        this.headerDone = false;
        this.unit = [];
        this.unitBytes = 0;
    }

    push(chunk) {
        const data = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
        const keep = NUT_SYNCPOINT.length - 1;
        if (data.length <= keep) { this.carry = data; return; }
        const emitEnd = data.length - keep; // a match found by indexOf always starts before this
        let from = 0;
        let idx = data.indexOf(NUT_SYNCPOINT, 0);
        while (idx !== -1) {
            if (idx > from) this._append(data.subarray(from, idx));
            this._boundary();
            from = idx;
            idx = data.indexOf(NUT_SYNCPOINT, idx + 1);
        }
        if (emitEnd > from) this._append(data.subarray(from, emitEnd));
        this.carry = Buffer.from(data.subarray(emitEnd)); // copy: don't pin the whole chunk for 7 bytes
    }

    _append(buf) {
        if (!this.headerDone) { this.headerPieces.push(buf); return; }
        this.unit.push(buf);
        this.unitBytes += buf.length;
    }

    _boundary() {
        if (!this.headerDone) {
            this.headerDone = true;
            const header = Buffer.concat(this.headerPieces);
            this.headerPieces = null;
            this.onHeader(header);
            return;
        }
        if (this.unitBytes > 0) this.onUnit(this.unit, this.unitBytes);
        this.unit = [];
        this.unitBytes = 0;
    }
}

// ----------------------------------------------------------------
// 🔌 RELAY CONSUMER — one downstream ffmpeg (recorder or live encoder).
// joining → live ⇄ skipping. Only whole units are ever written.
// ----------------------------------------------------------------
class RelayConsumer {
    constructor(proc, who, { pauseBytes, resumeBytes, log }) {
        this.proc = proc;
        this.who = who;
        this.pauseBytes = pauseBytes;
        this.resumeBytes = resumeBytes;
        this.log = log;
        this.state = 'joining';
        this.unitsWritten = 0;
        this.unitsSkipped = 0;
        this.skipEpisodes = 0;
        this._episodeSkipped = 0;
        this.attachedAt = Date.now();
        this.lastWriteAt = null;
    }

    get writable() {
        const s = this.proc && this.proc.stdin;
        return !!(s && s.writable && !s.destroyed);
    }

    deliver(header, pieces, bytes) {
        if (!this.writable) return;
        const stdin = this.proc.stdin;
        if (this.state === 'joining') {
            if (!header) return; // this leg hasn't produced its header yet — wait
            stdin.cork();
            stdin.write(header);
            this._writePieces(stdin, pieces);
            stdin.uncork();
            this.state = 'live';
            return;
        }
        if (this.state === 'live' && stdin.writableLength > this.pauseBytes) {
            this.state = 'skipping';
            this.skipEpisodes++;
            this._episodeSkipped = 0;
        }
        if (this.state === 'skipping') {
            if (stdin.writableLength > this.resumeBytes) {
                this.unitsSkipped++;
                this._episodeSkipped++;
                return;
            }
            this.state = 'live';
            this.log(`[relay] ${this.who} fell behind — skipped ${this._episodeSkipped} relay packets, now caught up (its output fills the gap, so its timeline and A/V sync are unaffected)`);
        }
        stdin.cork();
        this._writePieces(stdin, pieces);
        stdin.uncork();
    }

    _writePieces(stdin, pieces) {
        for (const p of pieces) stdin.write(p);
        this.unitsWritten++;
        this.lastWriteAt = Date.now();
    }

    // Ends stdin — always on a unit boundary, since only whole units are
    // ever written. ffmpeg then finishes normally (proper MP4 fragments/
    // FLV end) instead of choking on a half packet.
    end() {
        try { if (this.writable) this.proc.stdin.end(); } catch (e) { /* already gone */ }
    }

    stats() {
        return {
            who: this.who, state: this.state,
            backlogBytes: this.writable ? this.proc.stdin.writableLength : 0,
            unitsWritten: this.unitsWritten, unitsSkipped: this.unitsSkipped, skipEpisodes: this.skipEpisodes,
        };
    }
}

// ----------------------------------------------------------------
// 🖼️ OVERLAY PACER — writes the latest overlay PNG to the compositor at
// a WALL-CLOCK-exact OVERLAY_FPS. The compositor's overlay filter can't
// output a frame for time t until the overlay input has reached t, so
// the overlay input's timeline gates the WHOLE program feed. The old
// setInterval(67ms) re-emitter ran at 14.93fps at best (and lost every
// tick the event loop was busy), so the overlay timeline fell steadily
// behind real time: the compositor output slowed below 1.0x, the
// camera's real-time buffer filled, and after a while the feed stalled —
// Live Output/recording "stuck after running for some time". Here the
// number of frames written always equals elapsed-time × fps, so the
// overlay timeline can never drift, whatever the timer jitter.
// ----------------------------------------------------------------
const OVERLAY_MAX_BACKLOG_BYTES = 32 * 1024 * 1024;
// 1×1 fully transparent PNG — sent until the overlay page delivers its
// first real frame (or whenever the overlay renderer is unavailable), so
// the camera feed, recording and stream never wait on the overlay page
// (a slow/unreachable overlay URL used to block the compositor from
// producing ANY video, and a failed page load failed Recording itself).
const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
class OverlayPacer {
    constructor(writable, getFrame, fps) {
        this.writable = writable;
        this.getFrame = getFrame;
        this.frameMs = 1000 / fps;
        this.t0 = Date.now();
        this.sent = 0;
        this.timer = setInterval(() => this._tick(), Math.max(10, Math.floor(this.frameMs / 2)));
    }
    _tick() {
        const frame = this.getFrame();
        if (!frame || !this.writable.writable) return;
        const due = Math.floor((Date.now() - this.t0) / this.frameMs);
        const n = due - this.sent;
        if (n <= 0) return;
        if (this.writable.writableLength > OVERLAY_MAX_BACKLOG_BYTES) return; // compositor not reading at all — its watchdog handles that; don't buffer without limit
        this.writable.cork();
        for (let i = 0; i < n; i++) this.writable.write(frame);
        this.writable.uncork();
        this.sent = due;
    }
    stop() { clearInterval(this.timer); }
}

// ----------------------------------------------------------------
// 📷 PREVIEW RECEIVER — the compositor streams a 2fps multipart-JPEG
// (-f mpjpeg) over loopback TCP; the latest frame is kept in memory and
// served by GET /capture-preview. Replaces writing program-preview.jpg
// to disk twice a second: on Windows any other process briefly opening
// that file (Defender, the indexer, a backup/sync client) made ffmpeg's
// image2 muxer fail, and ONE failed output terminates the whole
// compositor — taking the recording and the stream with it.
// ----------------------------------------------------------------
class MpjpegParser {
    constructor(onFrame) {
        this.onFrame = onFrame;
        this.buf = Buffer.alloc(0);
    }
    push(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        for (;;) {
            const headerEnd = this.buf.indexOf('\r\n\r\n');
            if (headerEnd === -1) {
                if (this.buf.length > 64 * 1024) this.buf = Buffer.alloc(0); // garbage — resync on the next boundary
                return;
            }
            const m = /content-length:\s*(\d+)/i.exec(this.buf.subarray(0, headerEnd).toString('latin1'));
            if (!m) { this.buf = this.buf.subarray(headerEnd + 4); continue; }
            const len = Number(m[1]);
            const start = headerEnd + 4;
            if (this.buf.length < start + len) return;
            this.onFrame(Buffer.from(this.buf.subarray(start, start + len)));
            this.buf = this.buf.subarray(start + len);
        }
    }
}

function listenLoopback(onConnection) {
    return new Promise((resolve, reject) => {
        const server = net.createServer(onConnection);
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            server.on('error', () => {});
            resolve(server);
        });
    });
}

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
//
// 🛠 ROOT-CAUSE FIX (that same AVMATRIX then being opened at 640x480).
// The cap that stopped the 1080p60 overrun was set to 40 MB/s, which is
// far below what the overrun actually required — raw 4:2:2 costs
// width*height*2 bytes per frame, so 40 MB/s rules out almost everything
// a capture card wants to run at:
//
//     1920x1080 @60 raw = 248 MB/s   <- the mode that really did overrun
//     1920x1080 @30 raw = 124 MB/s   <- fine on USB 3.0, but was rejected
//     1280x720  @30 raw =  55 MB/s   <- fine anywhere, but was rejected
//      960x540  @30 raw =  31 MB/s   <- allowed
//      640x480  @30 raw =  18 MB/s   <- allowed, and so this is what won
//
// The device was then opened at 640x480 and UPSCALED to 720p/1080p for
// the stream: soft, blocky output that looks nothing like the source,
// with no error anywhere — the log line just read
// "camera mode auto-detected: 640x480@30 (raw)".
//
// So the cap is kept, but set where the evidence actually puts it: above
// 1080p30/720p60, below the 1080p60 mode that overran. USB 3.0 sustains
// roughly 300-400 MB/s in practice, so 1080p30 has real headroom; 1080p60
// raw stays excluded exactly as the field fix intended.
// STREAM_ENGINE_RAW_CAP_MBPS=40 restores the old behaviour exactly.
const RAW_BANDWIDTH_CAP_BYTES_PER_SEC =
    (Number(process.env.STREAM_ENGINE_RAW_CAP_MBPS) || 150) * 1024 * 1024;

// Explicit operator override, e.g. STREAM_ENGINE_CAMERA_MODE=1920x1080@30.
// Auto-detection can only choose from what the driver ADVERTISES, and
// capture cards under-report constantly; this ends the guessing.
function parseCameraModeOverride(raw) {
    const m = /^\s*(\d+)\s*[xX*]\s*(\d+)\s*(?:@\s*([\d.]+))?\s*$/.exec(String(raw || ''));
    if (!m) return null;
    const width = Number(m[1]), height = Number(m[2]);
    const fps = m[3] ? Number(m[3]) : 30;
    if (!width || !height || !fps) return null;
    // Shaped exactly like a pickCameraMode() result so every caller
    // downstream (buildCompositorArgs' -video_size/-framerate) is unchanged.
    return { width, height, fps, minFps: fps, maxFps: fps, compressed: false, forced: true };
}

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


function buildCompositorArgs({ cameraDeviceName, audioDeviceName, width, height, fps, overlayInputUrl, previewOutputUrl, cameraVideoSize, cameraFramerate }) {
    const filterComplex =
        `[0:v]scale=${width}:${height}:flags=lanczos,setsar=1,fps=${fps},format=yuv420p[cam];` +
        `[2:v]scale=${width}:${height},format=rgba[ovl];` +
        `[cam][ovl]overlay=0:0:format=auto,format=yuv420p` +
        (previewOutputUrl
            // The preview branch is decimated to 2fps BEFORE scaling, so it
            // costs next to nothing; out_range=full gives the JPEG encoder
            // the full-range YUV it requires without a deprecated yuvj format.
            ? `,split=2[vout1][pv];[pv]fps=${PREVIEW_FPS},scale=${PREVIEW_WIDTH}:-2:out_range=full[vout2]`
            : '[vout1]');
    const args = [
        '-hide_banner', '-loglevel', 'warning', '-nostats',
        // Input 0: camera (video only). Input 1: mic/capture-card audio
        // (separate dshow input, NOT combined as one "video=X:audio=Y"
        // graph) — 🩹 CONFIRMED IN THE FIELD: the combined syntax failed
        // with a generic "Error opening input files: I/O error" the
        // moment video and audio came from two independent physical
        // devices. cameraMode is resolved by probeCameraMode() FROM THE
        // DEVICE ITSELF (ffmpeg -f dshow -list_options true) — a
        // hardcoded -video_size/-framerate was wrong twice in the field.
        // 🛠 ROOT-CAUSE FIX (live output arriving seconds behind reality).
        // -rtbufsize is the ceiling on how much CAPTURED-BUT-NOT-YET-CONSUMED
        // video ffmpeg will hold in memory. It is not a safety net: it is a
        // latency allowance. Whenever the compositor falls even slightly
        // behind the camera, ffmpeg fills this buffer instead of dropping,
        // and every byte in it is delay the viewer sees and never gets back.
        //
        // At 512M that was catastrophic on a raw feed:
        //     512 MB / (640*480*2 bytes/frame) = ~833 frames = ~27 SECONDS
        // The stream was not "laggy" in the sense of stuttering — it was
        // running tens of seconds late, which is exactly what makes a
        // YouTube go-live unusable.
        //
        // A live program feed must DROP late frames, not queue them. This
        // buffer is now sized for a fraction of a second of absorption
        // (momentary scheduling hiccups) and nothing more; past that,
        // ffmpeg logs "real-time buffer too full, frame dropped", which is
        // the correct behaviour for live and keeps latency flat.
        // -fflags nobuffer / -flags low_delay stop the demuxer adding its
        // own reordering delay on top.
        '-fflags', 'nobuffer', '-flags', 'low_delay',
        '-f', 'dshow', '-rtbufsize', CAMERA_RTBUFSIZE,
        ...(cameraVideoSize ? ['-video_size', cameraVideoSize] : []),
        ...(cameraFramerate ? ['-framerate', String(cameraFramerate)] : []),
        '-i', `video=${cameraDeviceName}`,
        // Audio is tiny by comparison; a small buffer here is genuinely just
        // jitter absorption and costs no meaningful latency.
        '-f', 'dshow', '-rtbufsize', '32M', '-i', `audio=${audioDeviceName}`,
        // Input 2: the overlay — back-to-back PNGs over loopback TCP from
        // OverlayPacer (image2pipe's png demuxer splits consecutive PNGs
        // on its own). Deliberately NOT stdin: stdin stays free for the
        // 'q' keypress, so Stop ends this process gracefully and the
        // camera driver is released properly instead of TerminateProcess.
        '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(OVERLAY_FPS), '-thread_queue_size', '512', '-i', overlayInputUrl,
        '-filter_complex', filterComplex,
        // Output 1: the relay — never displayed, so never re-encoded here.
        '-map', '[vout1]', '-map', '1:a', ...RELAY_CONTAINER_ARGS, 'pipe:1',
    ];
    // Output 2: the Program Preview (see MpjpegParser) — a real consumer
    // of the same composited stream, camera+overlay together.
    if (previewOutputUrl) args.push('-map', '[vout2]', '-an', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'mpjpeg', previewOutputUrl);
    return args;
}

function buildRecorderEncoderArgs({ width, height, fps, bitrateKbps, outFile, useNvenc }) {
    const videoArgs = useNvenc
        ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-b:v', `${bitrateKbps}k`, '-maxrate', `${Math.round(bitrateKbps * 1.3)}k`]
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${bitrateKbps}k`];
    return [
        '-hide_banner', '-loglevel', 'warning', '-nostats',
        '-f', 'nut', '-thread_queue_size', '1024', '-i', 'pipe:0',
        '-r', String(fps),
        ...videoArgs,
        // Short (2s) GOP + fragmented MP4 — at most ~2s of footage is
        // ever at risk if this process is killed, and the file stays
        // playable up to the last flushed fragment.
        '-g', String(fps * 2), '-keyint_min', String(fps * 2),
        '-af', 'aresample=async=1:first_pts=0',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-flush_packets', '1',
        '-max_muxing_queue_size', '4096',
        // Machine-readable progress (out_time/frame) on stderr — parsed,
        // never printed. It is how server.js knows the recording is
        // really advancing (watchdog) and maps wall-clock clip times onto
        // this file's own timeline.
        '-progress', 'pipe:2',
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
        // — this scales to whatever this encoder was asked to push.
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
        // RTMP is not seekable — without this, every stop logs "Failed to
        // update header with correct duration/filesize" (harmless noise).
        '-flvflags', 'no_duration_filesize',
        '-f', 'flv',
        '-progress', 'pipe:2', '-nostats',
        destinationUrl,
    ];
}

// ----------------------------------------------------------------
// 🔗 COMPOSITOR — ref-counted (see this file's header comment). One
// instance total; started by whichever of recording/streaming/preview
// asks for it first, stopped by server.js once none of them needs it.
// ----------------------------------------------------------------
class Compositor extends EventEmitter {
    constructor({ spawnFfmpeg, execPath, overlayUrl, width, height, fps, log }) {
        super();
        this.spawnFfmpeg = spawnFfmpeg;
        this.execPath = execPath;
        this.overlayUrl = overlayUrl;
        this.width = width;
        this.height = height;
        this.fps = fps;
        this.log = log || ((line) => console.log(line));
        this.proc = null;
        this.overlay = null;
        this.overlayFrame = null;   // latest overlay PNG — survives an overlay-bridge relaunch
        this.state = 'idle';        // idle | starting | running | relaunching | stopping
        this.refs = new Set();      // 'recorder' | 'live' | 'preview'
        this.consumers = new Map(); // consumer proc -> RelayConsumer
        this.lastError = null;
        this.startedAt = null;
        this.cameraMode = null;     // resolved once by probeCameraMode(), cached for this instance's lifetime
        this.previewJpeg = null;
        // Live preview subscribers (see onPreviewFrame) — each is a function
        // that receives every composited preview JPEG as it is produced.
        this.previewSubscribers = new Set();
        this.previewAt = null;
        this.stopped = false;
        this._startPromise = null;
        this._relaunchTimer = null;
        this._relaunchAttempt = 0;
        this.legCount = 0;
        this.relay = { bytes: 0, units: 0, lastDataAt: null, bytesPerSec: 0 };
        const frameBytes = Math.round(width * height * 1.5);
        this.relayBytesPerSec = frameBytes * fps + 44100 * 2 * 2;
        this.pauseBytes = Math.round(this.relayBytesPerSec * RELAY_PAUSE_SEC);
        this.resumeBytes = Math.round(this.relayBytesPerSec * RELAY_RESUME_SEC);
        this._watchdog = setInterval(() => this._checkHealth(), 2000);
        if (this._watchdog.unref) this._watchdog.unref();
    }

    addRef(who) { this.refs.add(who); }
    removeRef(who) { this.refs.delete(who); return this.refs.size; }

    // 🎯 vMix-style auto-detect: ask this exact camera what it actually
    // supports and pick a real mode, instead of a hardcoded guess.
    // Best-effort — a device this can't probe/parse falls back to no
    // constraint. Async (the old spawnSync froze the event loop for up
    // to 8s, stalling every other process's pipes with it).
    // Subscribe to the live preview. Returns an unsubscribe function.
    // Back-pressure is the caller's problem by design: a slow viewer must
    // never be allowed to stall the compositor, so callers drop frames
    // rather than queue them (see the /capture-preview/stream handler).
    onPreviewFrame(fn) {
        this.previewSubscribers.add(fn);
        return () => this.previewSubscribers.delete(fn);
    }

    probeCameraMode(cameraDeviceName) {
        return new Promise((resolve) => {
            let out = '';
            let proc;
            try {
                proc = this.spawnFfmpeg(['-hide_banner', '-f', 'dshow', '-list_options', 'true', '-i', `video=${cameraDeviceName}`], { stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (e) {
                this.log(`[compositor] camera mode probe failed (${e.message}) — opening unconstrained`);
                return resolve(null);
            }
            const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 8000);
            proc.stdout.on('data', (d) => { out += d; });
            proc.stderr.on('data', (d) => { out += d; });
            proc.on('error', () => {});
            proc.on('close', () => {
                clearTimeout(timer);
                // 🩹 The override exists because auto-detection can only pick
                // from what the driver ADVERTISES, and capture cards lie or
                // under-report all the time. If the operator knows the card
                // does 1920x1080@30, STREAM_ENGINE_CAMERA_MODE=1920x1080@30
                // settles it with no guessing at all.
                const override = parseCameraModeOverride(process.env.STREAM_ENGINE_CAMERA_MODE);
                if (override) {
                    this.log(`[compositor] camera mode FORCED by STREAM_ENGINE_CAMERA_MODE: ${override.width}x${override.height}@${override.fps}`);
                    clearTimeout(timer);
                    return resolve(override);
                }
                // Log every mode the device actually offered. Without this the
                // operator had no way to tell a bad PICK from a device that
                // genuinely only offers one small mode — the single
                // "auto-detected: 640x480@30" line looked the same either way.
                const offered = parseDshowVideoModes(out);
                if (offered.length) {
                    const seen = [...new Set(offered.map((m) => `${m.width}x${m.height}@${Math.round(m.maxFps)}${m.compressed ? ' mjpeg' : ' raw'}`))];
                    this.log(`[compositor] camera offers ${seen.length} mode(s): ${seen.join(', ')}`);
                }
                const mode = pickCameraMode(out, this.width, this.height, this.fps);
                if (mode) {
                    this.log(`[compositor] camera mode auto-detected: ${mode.width}x${mode.height}@${mode.fps}${mode.compressed ? ' (compressed)' : ' (raw)'}`);
                    if (!mode.compressed && (mode.width < this.width || mode.height < this.height)) {
                        this.log(`[compositor] ⚠ the camera is opening BELOW the program resolution (${mode.width}x${mode.height} < ${this.width}x${this.height}) — the feed will be upscaled and look soft. If this device really does support ${this.width}x${this.height}, force it with STREAM_ENGINE_CAMERA_MODE=${this.width}x${this.height}@${this.fps}`);
                    }
                } else {
                    this.log('[compositor] could not auto-detect a camera mode from -list_options output — opening unconstrained');
                }
                resolve(mode);
            });
        });
    }

    // Idempotent and concurrency-safe: callers arriving while a start is
    // in flight share its result instead of each launching (or, as
    // before, being told "ok" before anything was actually running).
    ensureRunning({ cameraDeviceName, audioDeviceName }) {
        if (this.stopped) return Promise.resolve({ ok: false, error: 'Compositor is stopping' });
        if (cameraDeviceName) this._cameraDeviceName = cameraDeviceName;
        if (audioDeviceName) this._audioDeviceName = audioDeviceName;
        if (this.state === 'running') return Promise.resolve({ ok: true });
        if (this._startPromise) return this._startPromise;
        if (this._relaunchTimer) { clearTimeout(this._relaunchTimer); this._relaunchTimer = null; }
        this._startPromise = this._start().finally(() => { this._startPromise = null; });
        return this._startPromise;
    }

    async _start() {
        this.state = 'starting';
        this.lastError = null;
        if (this.cameraMode === null) this.cameraMode = (await this.probeCameraMode(this._cameraDeviceName)) || false; // false = "probed, nothing usable"
        if (this.stopped) return { ok: false, error: 'Compositor is stopping' };
        // The overlay renderer is started alongside, never in front of,
        // the camera: if it can't come up, the program feed runs with a
        // transparent overlay and the bridge keeps retrying in background.
        this._startOverlayInBackground();
        const result = await this._spawnLeg();
        if (!result.ok) this.state = 'idle';
        return result;
    }

    _startOverlayInBackground() {
        if (this.stopped || (this.overlay && !this.overlay.stopped) || this._overlayStarting) return;
        if (!overlayBridgeAvailable()) {
            if (!this._warnedNoPuppeteer) this.log("[compositor] ⚠ puppeteer-core is not installed (run 'npm install' in stream-engine/) — program feed runs WITHOUT the score overlay");
            this._warnedNoPuppeteer = true;
            return;
        }
        this._overlayStarting = true;
        this._ensureOverlayBridge().then((r) => {
            this._overlayStarting = false;
            if (r.ok) {
                if (this._overlayFailures) this.log('[compositor] overlay renderer is back — score overlay restored');
                this._overlayFailures = 0;
                return;
            }
            if (this.stopped) return;
            const delay = Math.min(10000 * 2 ** (this._overlayFailures || 0), 60000);
            this._overlayFailures = (this._overlayFailures || 0) + 1;
            if (!this._logOverlayFailure) this._logOverlayFailure = makeRepeatSuppressingLogger('[compositor] ⚠', this.log, 5 * 60000);
            this._logOverlayFailure(`${r.error} — camera feed continues without the overlay; retrying (every ≤60s)`);
            this._overlayRetryTimer = setTimeout(() => this._startOverlayInBackground(), delay);
        });
    }

    async _ensureOverlayBridge() {
        if (this.overlay && !this.overlay.stopped) return { ok: true };
        const overlay = new OverlayBridge({ execPath: this.execPath, url: this.overlayUrl, width: this.width, height: this.height });
        overlay.on('frame', (png) => { this.overlayFrame = png; });
        // Chromium dying mid-match must not take the program feed down:
        // the pacer keeps re-sending the last overlay frame while a new
        // bridge is brought up; ffmpeg never notices.
        overlay.on('disconnected', () => {
            if (this.stopped || this.overlay !== overlay) return;
            this.log('[compositor] overlay renderer (Chromium) exited unexpectedly — relaunching it; the program feed keeps the last overlay frame meanwhile');
            this.overlay = null;
            this._overlayRetryTimer = setTimeout(() => this._startOverlayInBackground(), 2000);
        });
        this.overlay = overlay;
        try {
            await overlay.start();
            if (this.stopped) { overlay.stop().catch(() => {}); return { ok: false, error: 'Compositor is stopping' }; }
            return { ok: true };
        } catch (e) {
            this.overlay = null;
            overlay.stop().catch(() => {});
            this.lastError = `Overlay bridge failed to start: ${e.message}`;
            return { ok: false, error: this.lastError };
        }
    }

    // One compositor ffmpeg "leg": camera + overlay compositing + relay +
    // preview. Everything that belongs to a leg (its loopback sockets,
    // pacer, splitter, header) is created here and torn down in its exit
    // handler, so nothing from a dead leg can leak into the next one.
    async _spawnLeg() {
        const leg = { header: null, overlayServer: null, previewServer: null, pacer: null, sockets: new Set() };
        try {
            leg.overlayServer = await listenLoopback((socket) => {
                leg.sockets.add(socket);
                socket.on('error', () => {});
                socket.on('close', () => { leg.sockets.delete(socket); if (leg.pacer) { leg.pacer.stop(); leg.pacer = null; } });
                if (leg.pacer) { socket.destroy(); return; } // only ever one reader
                socket.setNoDelay(true);
                leg.pacer = new OverlayPacer(socket, () => this.overlayFrame || TRANSPARENT_PNG, OVERLAY_FPS);
            });
            leg.previewServer = await listenLoopback((socket) => {
                leg.sockets.add(socket);
                socket.on('error', () => {});
                socket.on('close', () => leg.sockets.delete(socket));
                const parser = new MpjpegParser((jpeg) => {
                    this.previewJpeg = jpeg;
                    this.previewAt = Date.now();
                    // 🖥️ Push to anyone watching the live preview stream. Kept
                    // deliberately trivial: a failed write to one dead socket
                    // must never touch the compositor, the recording or the
                    // YouTube push, so every subscriber is wrapped and a
                    // broken one is simply dropped.
                    if (this.previewSubscribers && this.previewSubscribers.size) {
                        for (const sub of this.previewSubscribers) {
                            try { sub(jpeg); } catch (e) { this.previewSubscribers.delete(sub); }
                        }
                    }
                });
                socket.on('data', (d) => parser.push(d));
            });
        } catch (e) {
            this._closeLegResources(leg);
            this.state = 'idle';
            this.lastError = `Could not open loopback sockets for the compositor: ${e.message}`;
            return { ok: false, error: this.lastError };
        }
        if (this.stopped) { this._closeLegResources(leg); return { ok: false, error: 'Compositor is stopping' }; }

        const args = buildCompositorArgs({
            cameraDeviceName: this._cameraDeviceName, audioDeviceName: this._audioDeviceName,
            width: this.width, height: this.height, fps: this.fps,
            overlayInputUrl: `tcp://127.0.0.1:${leg.overlayServer.address().port}`,
            previewOutputUrl: `tcp://127.0.0.1:${leg.previewServer.address().port}`,
            cameraVideoSize: this.cameraMode ? `${this.cameraMode.width}x${this.cameraMode.height}` : null,
            cameraFramerate: this.cameraMode ? this.cameraMode.fps : null,
        });
        let proc;
        try {
            proc = this.spawnFfmpeg(args, { stdio: ['pipe', 'pipe', 'pipe'] }, 'compositor');
        } catch (e) {
            this._closeLegResources(leg);
            this.state = 'idle';
            this.lastError = `Could not launch compositor: ${e.message}`;
            return { ok: false, error: this.lastError };
        }
        setProcessPriority(proc, os.constants.priority.PRIORITY_ABOVE_NORMAL);
        this.legCount++;
        this.proc = proc;
        this.leg = leg;
        this.state = 'running';
        this.startedAt = this.startedAt || Date.now();
        this.legStartedAt = Date.now();
        this.relay.lastDataAt = null;
        proc.stdin.on('error', () => {});

        const splitter = new NutUnitSplitter({
            onHeader: (header) => { leg.header = header; },
            onUnit: (pieces, bytes) => {
                this.relay.units++;
                for (const consumer of this.consumers.values()) consumer.deliver(leg.header, pieces, bytes);
            },
        });
        proc.stdout.on('data', (chunk) => {
            this.relay.bytes += chunk.length;
            this.relay.lastDataAt = Date.now();
            splitter.push(chunk);
        });

        const logLine = this._makeLineLogger('[compositor]');
        let stderrBuf = '';
        proc.stderr.on('data', (chunk) => {
            stderrBuf += chunk.toString();
            let idx;
            while ((idx = stderrBuf.search(/[\r\n]/)) >= 0) {
                const line = stderrBuf.slice(0, idx).trim();
                stderrBuf = stderrBuf.slice(idx + 1);
                if (!line) continue;
                if (!BENIGN_LINE_RE.test(line)) logLine(line);
                if (/error|failed|cannot|invalid|no space/i.test(line)) this.lastError = line;
            }
            if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
        });

        proc.on('error', (err) => { this.lastError = err.message; });
        proc.on('exit', (code, signal) => this._onLegExit(proc, leg, code, signal));
        return { ok: true };
    }

    _closeLegResources(leg) {
        if (!leg) return;
        if (leg.pacer) { leg.pacer.stop(); leg.pacer = null; }
        for (const s of leg.sockets) { try { s.destroy(); } catch (e) {} }
        leg.sockets.clear();
        for (const srv of [leg.overlayServer, leg.previewServer]) { try { if (srv) srv.close(); } catch (e) {} }
    }

    // Ends every attached consumer (each on a unit boundary) — used when
    // the leg they were reading dies, so they exit and restart through
    // their own paths instead of waiting forever on a silent pipe.
    _endAllConsumers() {
        for (const consumer of this.consumers.values()) consumer.end();
        this.consumers.clear();
    }

    _onLegExit(proc, leg, code, signal) {
        this._closeLegResources(leg);
        if (this.proc !== proc) return;
        this.proc = null;
        this.leg = null;
        this._endAllConsumers();
        if (this.stopped) return; // stop() reports this itself
        const ranMs = Date.now() - (this.legStartedAt || Date.now());
        this.log(`[compositor] ffmpeg exited unexpectedly after ${Math.round(ranMs / 1000)}s (code=${code}, signal=${signal})${this.lastError ? ` — last error: ${this.lastError}` : ''}`);
        this.emit('unexpected-exit', { code, signal, lastError: this.lastError });
        this.state = 'idle';
        if (ranMs >= COMPOSITOR_STABLE_RESET_MS) this._relaunchAttempt = 0;
        this._scheduleRelaunch();
    }

    // Self-heal while anything still needs the feed. The recorder and
    // live encoder re-attach through their own restart paths and simply
    // join the new leg.
    _scheduleRelaunch() {
        if (this.stopped || this.refs.size === 0 || this._relaunchTimer) return;
        const delay = COMPOSITOR_RELAUNCH_BACKOFF_MS[Math.min(this._relaunchAttempt, COMPOSITOR_RELAUNCH_BACKOFF_MS.length - 1)];
        this._relaunchAttempt++;
        this.state = 'relaunching';
        this.log(`[compositor] relaunching in ${delay / 1000}s (attempt ${this._relaunchAttempt})`);
        this._relaunchTimer = setTimeout(() => {
            this._relaunchTimer = null;
            this.state = 'idle';
            if (this.stopped || this.refs.size === 0) return;
            this.ensureRunning({}).then((r) => {
                if (r.ok || this.stopped) return;
                this.log(`[compositor] relaunch failed: ${r.error}`);
                this._scheduleRelaunch();
            });
        }, delay);
    }

    // 🩺 A leg that is "running" but has stopped producing relay data is
    // exactly the silent failure an operator can't see: every consumer
    // is alive, nothing is written. Kill it; _onLegExit handles the rest.
    _checkHealth() {
        if (this.state !== 'running' || !this.proc || this.stopped) return;
        const now = Date.now();
        const sinceStart = now - this.legStartedAt;
        const last = this.relay.lastDataAt;
        let reason = null;
        if (!last && sinceStart > COMPOSITOR_STARTUP_GRACE_MS) reason = `no video produced ${Math.round(sinceStart / 1000)}s after start`;
        else if (last && now - last > COMPOSITOR_STALL_MS) reason = `no video produced for ${Math.round((now - last) / 1000)}s`;
        if (!reason) return;
        this.lastError = `stalled — ${reason}`;
        this.log(`[compositor] ⚠ stalled (${reason}) — restarting the compositor`);
        try { this.proc.kill('SIGKILL'); } catch (e) {}
    }

    // Registers a downstream process's stdin as a relay consumer. It
    // receives [header][units…] starting at the next unit — no restart of
    // the leg, no stale replay, no effect on any other consumer.
    attachRelayConsumer(proc, who) {
        if (this.stopped) return { ok: false, error: 'Compositor is stopping' };
        if (!proc || !proc.stdin) return { ok: false, error: 'consumer already gone before it could attach' };
        this.consumers.set(proc, new RelayConsumer(proc, who, { pauseBytes: this.pauseBytes, resumeBytes: this.resumeBytes, log: this.log }));
        return { ok: true };
    }

    // Detaches a consumer. With end=true its stdin is closed right away —
    // always on a unit boundary — so it finishes its file/stream cleanly.
    detachRelayConsumer(proc, { end = false } = {}) {
        const consumer = this.consumers.get(proc);
        this.consumers.delete(proc);
        if (end && consumer) consumer.end();
    }

    // Graceful: 'q' on stdin lets ffmpeg close the camera/audio devices
    // itself; SIGKILL only if it hasn't exited within timeoutMs.
    stop({ timeoutMs = 4000 } = {}) {
        if (this._stopPromise) return this._stopPromise;
        this.stopped = true;
        this.state = 'stopping';
        clearInterval(this._watchdog);
        if (this._relaunchTimer) { clearTimeout(this._relaunchTimer); this._relaunchTimer = null; }
        if (this._overlayRetryTimer) { clearTimeout(this._overlayRetryTimer); this._overlayRetryTimer = null; }
        this._endAllConsumers();
        const proc = this.proc;
        this._stopPromise = new Promise((resolve) => {
            const finish = () => {
                this._closeLegResources(this.leg);
                this.proc = null;
                this.leg = null;
                const overlay = this.overlay;
                this.overlay = null;
                const closeOverlay = overlay ? overlay.stop().catch(() => {}) : Promise.resolve();
                closeOverlay.then(() => {
                    this.state = 'idle';
                    this.log('[compositor] stopped');
                    resolve();
                });
            };
            if (!proc || proc.exitCode !== null || proc.signalCode !== null) return finish();
            const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
            proc.once('exit', () => { clearTimeout(killTimer); finish(); });
            try { proc.stdin.write('q'); } catch (e) { /* already gone */ }
        });
        return this._stopPromise;
    }

    stats() {
        const now = Date.now();
        return {
            state: this.state,
            legs: this.legCount,
            relayMBps: this.relay.lastDataAt && now - this.relay.lastDataAt < 5000 ? Math.round(this.relayBytesPerSec / 1e5) / 10 : 0,
            lastRelayDataAgoMs: this.relay.lastDataAt ? now - this.relay.lastDataAt : null,
            previewAgeMs: this.previewAt ? now - this.previewAt : null,
            consumers: [...this.consumers.values()].map((c) => c.stats()),
        };
    }

    // Repeated identical ffmpeg warnings (e.g. dshow's "real-time buffer
    // too full") are collapsed instead of flooding the operator's console.
    _makeLineLogger(prefix) {
        return makeRepeatSuppressingLogger(prefix, this.log);
    }
}

// Prints each distinct line once per window; repeats inside the window
// are counted and summarized on the next distinct print. Numbers are
// ignored when comparing, so "frame 1201 dropped"/"frame 1202 dropped"
// count as the same message.
function makeRepeatSuppressingLogger(prefix, log = (l) => console.log(l), windowMs = 60000) {
    const seen = new Map(); // key -> { at, suppressed }
    return (line) => {
        const key = line.replace(/0x[0-9a-f]+/gi, '#').replace(/\d+(\.\d+)?/g, '#');
        const now = Date.now();
        const entry = seen.get(key);
        if (entry && now - entry.at < windowMs) { entry.suppressed++; return; }
        const suppressed = entry ? entry.suppressed : 0;
        seen.set(key, { at: now, suppressed: 0 });
        if (seen.size > 200) { for (const [k, v] of seen) { if (now - v.at >= windowMs) seen.delete(k); } }
        log(`${prefix} ${line}${suppressed ? `  (+${suppressed} similar in the last ${Math.round(windowMs / 1000)}s)` : ''}`);
    };
}

module.exports = {
    Compositor,
    NutUnitSplitter,
    RelayConsumer,
    MpjpegParser,
    buildCompositorArgs,
    buildRecorderEncoderArgs,
    buildLiveEncoderArgs,
    overlayBridgeAvailable,
    makeRepeatSuppressingLogger,
    setProcessPriority,
    OVERLAY_FPS,
    parseDshowVideoModes,
    pickCameraMode,
    parseCameraModeOverride,
    RAW_BANDWIDTH_CAP_BYTES_PER_SEC,
    PREVIEW_FPS,
    PREVIEW_WIDTH,
};
