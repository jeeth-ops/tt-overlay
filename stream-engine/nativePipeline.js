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
const sourceProbe = require('./sourceProbe');

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
// 🛠 A CEILING, applied as an INTEGER step of the program rate (framestep).
// It used to be a flat `fps=15`: a 2:1 knife edge on a 30p program and an
// uneven 3.33:1 on 50p — so the operator's preview juddered even when the
// program itself was clean, and "the preview stutters" was indistinguishable
// from "the program stutters". Now 25/30p preview at full rate, 50/60p at
// half: every preview frame is a program frame, evenly spaced.
const PREVIEW_FPS = Number(process.env.STREAM_ENGINE_PREVIEW_FPS) || 30;
function previewStep(programFps) { return Math.max(1, Math.ceil((Number(programFps) || 30) / PREVIEW_FPS - 0.01)); }
const PREVIEW_WIDTH = Number(process.env.STREAM_ENGINE_PREVIEW_WIDTH) || 960;
// See the -rtbufsize comment in buildCompositorArgs() for why this is
// deliberately small. Raise it only if ffmpeg reports dropped frames on a
// machine you know is otherwise keeping up.
const CAMERA_RTBUFSIZE = process.env.STREAM_ENGINE_CAMERA_RTBUFSIZE || '64M';

// 🕐 ONE REAL SECOND MUST STAY ONE REAL SECOND — and which clock says so.
//
// Two candidate clocks for a camera frame:
//
//   device    dshow's sample time: stamped by the capture driver when the
//             frame was CAPTURED. Microsecond-steady, and unaffected by
//             ffmpeg reading late. What vMix/OBS time frames by.
//   wallclock -use_wallclock_as_timestamps: the moment ffmpeg READS the
//             frame. Honest in aggregate, but it carries every scheduling
//             hiccup, and after a stall a backlog is read in a burst and
//             stamped microseconds apart.
//
// Device stamps are only wrong on a device that stamps frames at its
// NOMINAL rate instead of their real capture time (50 real frames stamped
// as 60 → plays 1.2× fast). That is a measurable property, so it is
// measured: the source probe compares device time against real time (see
// sourceProbe.js) and the plan picks `device` only when they agree within
// 1%. Unmeasured, wallclock stays the default, exactly as before.
//
// STREAM_ENGINE_WALLCLOCK_TS=1 forces wallclock, =0 forces device stamps.
const WALLCLOCK_TS_OVERRIDE = process.env.STREAM_ENGINE_WALLCLOCK_TS === '1' ? 'wallclock'
    : process.env.STREAM_ENGINE_WALLCLOCK_TS === '0' ? 'device' : null;
// The source probe runs once per device+mode+program rate, before the first
// compositor leg. STREAM_ENGINE_SOURCE_PROBE=0 skips it (plan from the
// advertised mode instead); STREAM_ENGINE_SOURCE_PROBE_SECONDS tunes it.
const SOURCE_PROBE_ENABLED = process.env.STREAM_ENGINE_SOURCE_PROBE !== '0';
const SOURCE_PROBE_SECONDS = Number(process.env.STREAM_ENGINE_SOURCE_PROBE_SECONDS) || 4;

// 🔊 AUDIO SAMPLE RATE — 48 kHz, everywhere, deliberately.
//
// Every path here used to encode at 44100. HDMI embedded audio — which is
// what an AV Matrix / capture card delivers — is 48000 Hz by specification,
// so that meant EVERY stage resampled 48k -> 44.1k at a non-integer 160:147
// ratio, for the whole match, for no benefit. YouTube's own ingest
// recommendation is 48 kHz AAC, so the conversion was not even buying
// compatibility.
//
// Matching the source rate removes a conversion from the recorder, the live
// encoder and the compositor relay alike, and removes one thing that can
// accumulate over a 7-hour run alongside aresample's own drift correction.
// A 44.1 kHz source (a laptop mic) now resamples instead — one conversion
// either way, and this is the direction that matches the broadcast hardware.
const AUDIO_SAMPLE_RATE_HZ = 48000;

const RELAY_CONTAINER_ARGS = ['-f', 'nut', '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ar', String(AUDIO_SAMPLE_RATE_HZ), '-ac', '2'];

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
// The capture meter's null output complains when two raw frames share a
// timestamp; it writes nothing, so that line is noise, not a fault.
const BENIGN_LINE_RE = /deprecated pixel format used|Guessed Channel Layout|\[null @[^\]]*\] Application provided invalid, non monotonically increasing dts/i;

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
//
// 🛠 THIS PNG WAS NOT TRANSPARENT. The previous bytes decode to one pixel of
// RGBA (0, 0, 255, 127) — 50%-opaque BLUE — which the compositor scaled over
// the whole frame: until the overlay page delivered its first frame (or for
// the whole match if puppeteer/Chromium was unavailable) the program, the
// master recording and YouTube were all tinted half blue. Found by the
// end-to-end simulation (every camera value came back at ~0.45× + an offset).
// These bytes decode to RGBA (0, 0, 0, 0); test/localIsolation.test.js pins it.
const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
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

// 🎯 WHAT TO ASK THE CAPTURE CARD FOR — deliberately NOT the output size.
//
// 🛠 THE BUG THIS REPLACES. The camera mode used to be chosen with
// pickCameraMode(out, this.width, this.height, this.fps) — i.e. targeting the
// PROGRAM resolution — and its sort prefers a mode whose area is <= the
// target. So selecting a 720x480 program made the engine ask an AVMATRIX
// card for a ~720x480-or-smaller mode: the HDMI source is 1920x1080, and the
// engine threw that away at the device, in the card's firmware, before any
// filter could do a controlled downscale. A 720x480 output must never cost
// capture quality.
//
// Same class of bug on frame rate: `this.fps` is the PROGRAM rate, which for
// 50i is 50 — but 50i is 50 FIELDS = 25 interlaced FRAMES, and dshow counts
// frames. Asking a 50i source for 50 is asking for a mode it does not have.
//
// So capture is chosen on its own terms: the LARGEST mode the device offers
// that can carry the required capture rate (subject to the raw-bandwidth cap
// and preferring compressed modes, exactly as before), with preferWidth/
// preferHeight as a ceiling rather than a target. Scaling to the output size
// then happens once, in the compositor, with a filter we control.
function pickCaptureMode(listOptionsOutput, { fps, programWidth = null, programHeight = null }) {
    const modes = parseDshowVideoModes(listOptionsOutput);
    if (!modes.length) return null;
    const wanted = Number(fps) || 25;
    const pw = Number(programWidth) || 0, ph = Number(programHeight) || 0;
    const scored = modes.map((mode) => {
        // The rate the DEVICE will actually run at. A device whose modes are
        // fixed at 60 runs at 60 whatever we ask for; we decimate afterwards.
        const modeFps = Math.min(mode.maxFps, Math.max(mode.minFps, wanted));
        const rawBytesPerSec = mode.width * mode.height * 2 * modeFps;
        const safe = mode.compressed || rawBytesPerSec <= RAW_BANDWIDTH_CAP_BYTES_PER_SEC;
        // 🛠 THIS TEST USED TO BE BACKWARDS. It required
        //     wanted >= floor(minFps) && wanted <= ceil(maxFps)
        // so on an AVMATRIX card whose modes are all FIXED at 60.0002 fps, a
        // 30p program failed `30 >= 60` on every single mode — none was a
        // candidate, and selection fell through to "largest mode that fits the
        // bandwidth cap", which chose 1440x900 for a 1920x1080 program. The
        // engine then CPU-upscaled 1440x900 -> 1920x1080 at 60fps, could not
        // keep up, and dshow's input buffer overflowed:
        //     real-time buffer ... too full (81%)! frame dropped!  (+112 in 60s)
        // — which is the stutter the operator saw in the program monitor, and
        // therefore in the recording and on YouTube too.
        //
        // The truth is one-directional: a higher rate can always be decimated
        // down, a lower one can never be made up. So a mode is a candidate if
        // it can reach the rate AT ALL.
        const carriesRate = wanted <= Math.ceil(mode.maxFps);
        const exact = pw && ph && mode.width === pw && mode.height === ph;
        const covers = pw && ph && mode.width >= pw && mode.height >= ph;
        return { ...mode, fps: modeFps, area: mode.width * mode.height, safe, carriesRate, exact, covers };
    });
    const can = scored.filter((m) => m.carriesRate);
    const pool = can.length ? can : scored;
    const bySmallest = (a, b) => (a.area - b.area) || ((a.compressed === b.compressed) ? 0 : (a.compressed ? -1 : 1));
    const byLargest = (a, b) => (b.area - a.area) || ((a.compressed === b.compressed) ? 0 : (a.compressed ? -1 : 1));
    // Preference order, most to least desirable. The first two need NO scale
    // filter at all or only a controlled downscale — and with GPU scaling
    // unavailable (CPU swscale) that is the single biggest cost in the graph,
    // so it outranks tidy bandwidth arithmetic.
    const tiers = [
        [pool.filter((m) => m.exact && m.safe), byLargest],          // perfect: no scale, within bandwidth
        [pool.filter((m) => m.covers && m.safe), bySmallest],        // downscale, least data to move
        [pool.filter((m) => m.exact), byLargest],                    // no scale beats an upscale, cap or not
        [pool.filter((m) => m.covers), bySmallest],                  // downscale, over the cap
        [pool.filter((m) => m.safe), byLargest],                     // upscale (soft) — warned about by the caller
        [pool, byLargest],
    ];
    for (const [tier, cmp] of tiers) {
        if (tier.length) { tier.sort(cmp); return tier[0]; }
    }
    return null;
}

// 🎞 CADENCE. Decimating 60 -> 30 keeps every other frame: even, smooth.
// Decimating 60 -> 25 is a 2.4:1 ratio — there is no even way to drop 35 of
// every 60 frames, so the motion judders however good the rest of the chain
// is. That is a property of the numbers, not a bug to fix downstream, and an
// operator choosing 25p on a 60fps-only card needs to be told rather than left
// wondering why it stutters.
function cadenceCheck(captureFps, programFps) {
    const cap = Number(captureFps) || 0, prog = Number(programFps) || 0;
    if (!cap || !prog) return { even: true, ratio: null };
    if (prog > cap) return { even: false, ratio: cap / prog, reason: 'more frames requested than the source produces' };
    const ratio = cap / prog;
    const even = Math.abs(ratio - Math.round(ratio)) < 0.02;
    return { even, ratio: Number(ratio.toFixed(3)), reason: even ? null : `${Math.round(cap)} does not divide evenly into ${prog}` };
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


function buildCompositorArgs({ cameraDeviceName, audioDeviceName, width, height, fps, overlayInputUrl, previewOutputUrl, cameraVideoSize, cameraFramerate, interlacedSource = false, sourcePlan = null, meter = true, clockBaseSec = null }) {
    // 🎯 CAPTURE FORMAT vs OUTPUT FORMAT. The camera opens at ITS best mode;
    // the program feed is whatever the operator chose. They are not the same
    // choice — a 720×480 program must NOT be got by forcing the capture card
    // down to 720×480, because then the downscale happens in the card's
    // firmware with no control over it (and the card may not even offer the
    // mode). So the scale happens HERE, once, with a filter we control.
    //
    // Same reasoning as the live encoder for skipping it entirely: when the
    // camera already opens at the program resolution, scaling is a no-op
    // that still costs a full resample of every frame. setsar/fps/format are
    // kept either way — cheap, and still needed to normalise the stream.
    //
    // 🎞 interlacedSource (50i): deinterlace BEFORE scaling. Scaling an
    // interlaced frame first blends the two fields together, after which
    // they can never be separated and the picture is permanently soft —
    // which is exactly the "feed clear nahi aata" difference against vMix.
    // mode=send_field gives one frame per field (50i -> 50p, keeping the
    // motion that makes 50i worth shooting), and parity=-1 takes field order
    // from the stream instead of assuming top-field-first.
    const camNeedsResize = !cameraVideoSize || cameraVideoSize !== `${width}x${height}`;
    const camScale = camNeedsResize ? `scale=${width}:${height}:flags=bicubic,` : '';
    // 🎯 THE NORMALIZATION CHAIN comes from the source PLAN (sourceProbe.js):
    // [drop the card's repeated frames] → [deinterlace, only if the pixels
    // are interlaced] → [rate: passthrough | framestep=k | fps (uneven,
    // warned)]. Without a measured plan it is derived from the advertised
    // device rate with the same rules.
    //
    // 🛠 WHY NOT `fps=<program>` ANY MORE. The fps filter anchors its output
    // grid on the FIRST frame, so on an exact 2:1 source (AVMATRIX 60 → 30p,
    // 50 → 25p) every odd source frame sits exactly on a rounding edge, and
    // the tiniest timestamp difference decides which of each pair is shown.
    // Simulated with the real filter: ~39% of program frames were the wrong
    // one (source steps 1/2/3 instead of 2) — judder — while the laptop
    // webcam (30 → 30, no decimation) was clean under the same jitter. That
    // is the AVMATRIX-only stutter. `framestep=k` selects by COUNT: 100%
    // clean, and cheaper. STREAM-ENGINE-AUDIT.md §K has the numbers.
    const plan = sourcePlan || sourceProbe.planFromAdvertised({ deviceFps: cameraFramerate, programFps: fps, interlacedSelected: interlacedSource });
    const camNorm = plan.chain ? `${plan.chain},` : '';
    // 🕐 ONE PROGRAM CLOCK (see PROGRAM_CLOCK below). 'device' only by explicit override.
    const timestamps = WALLCLOCK_TS_OVERRIDE || 'wallclock';
    const clockBase = Number.isFinite(clockBaseSec) ? clockBaseSec : Date.now() / 1000;
    const onProgramClock = timestamps === 'wallclock'
        ? ['-use_wallclock_as_timestamps', '1', '-itsoffset', (-clockBase).toFixed(3)]
        : [];
    // 🛠 ORDER: normalize (dedupe → deinterlace → DECIMATE) -> scale. Scaling
    // frames that are about to be discarded is what pushed the compositor
    // behind the camera and overflowed dshow's input buffer. yadif stays
    // before the scale: it needs the fields intact.
    //
    // 📏 CAPTURE METER: a point-sampled 64×36 copy of every RAW captured
    // frame (before any normalization) goes to showinfo on a separate null
    // output. It is the live record of what the device is really delivering —
    // arrival rate, timestamp honesty, repeated frames, gaps — and costs a
    // few thousand pixels per frame. See CaptureMeter.
    //
    // Inputs: 0 = overlay, 1 = audio, 2 = camera (see PROGRAM_CLOCK for why
    // the camera is opened LAST).
    const camIn = meter ? '[camraw]' : '[2:v]';
    const meterGraph = meter ? '[2:v]split=2[camraw][mraw];[mraw]scale=64:36:flags=neighbor,showinfo[meter];' : '';
    const filterComplex =
        meterGraph +
        `${camIn}${camNorm}${camScale}setsar=1,format=yuv420p[cam];` +
        `[0:v]scale=${width}:${height},format=rgba[ovl];` +
        `[cam][ovl]overlay=0:0:format=auto,format=yuv420p` +
        (previewOutputUrl
            // The preview branch is decimated to 2fps BEFORE scaling, so it
            // costs next to nothing; out_range=full gives the JPEG encoder
            // the full-range YUV it requires without a deprecated yuvj format.
            ? `,split=2[vout1][pv];[pv]${previewStep(fps) > 1 ? `framestep=${previewStep(fps)},` : ''}scale=${PREVIEW_WIDTH}:-2:out_range=full[vout2]`
            : '[vout1]');
    const args = [
        // level+info: the capture meter's showinfo lines and the negotiated
        // input stream description are info-level; every line carries its
        // [level] tag so Compositor routes them (warnings still reach the log).
        '-hide_banner', '-loglevel', 'level+info', '-nostats',
        // -fflags nobuffer / -flags low_delay stop the demuxers adding their
        // own reordering delay.
        '-fflags', 'nobuffer', '-flags', 'low_delay',
        // 🕐 PROGRAM_CLOCK — THE ONE AUTHORITATIVE MEDIA TIMELINE.
        //
        // 🛠 ROOT CAUSE THIS FIXES (measured, STREAM-ENGINE-AUDIT.md §K3).
        // ffmpeg opens inputs one after another and, without -copyts, moves
        // EACH input's first packet to t=0 on its own. The inputs do not start
        // together: the overlay pipe took 7.9 s to open in simulation, the
        // audio device opens after the camera. So the camera's t=0 and the
        // overlay's t=0 were seconds apart in real time, and the overlay
        // filter — which cannot emit camera frame t until it has an overlay
        // frame at t — held EVERY camera frame for that gap:
        //   • with a queue big enough (the old 512 packets = ~2 GB at 1080p60)
        //     the program ran ~8 s behind reality;
        //   • with anything smaller, the queue filled, dshow dropped, and the
        //     feed moved in bursts between long freezes ("More than 1000
        //     frames duplicated" in the relay).
        // A 60 fps capture card needs twice the queue a 30 fps webcam does to
        // ride out the same gap — the AVMATRIX path hits the wall first.
        // The same per-input zero put AUDIO off the video by however long
        // the audio device took to open: a lip-sync error.
        //
        // Now every input is stamped by the SAME clock (arrival wall time),
        // -copyts keeps those stamps instead of re-zeroing each input, and one
        // common -itsoffset subtracts the same base from all of them. Camera
        // frame, audio sample and overlay frame that happened at the same
        // moment carry the same timestamp; the overlay filter picks the
        // latest overlay at or before each camera frame and never waits more
        // than one overlay interval.
        //
        // The camera is opened LAST, so the moment it starts delivering,
        // overlay and audio are already flowing: nothing it produces ever
        // waits on another input, and its bounded queue stays near empty.
        ...(timestamps === 'wallclock' ? ['-copyts'] : []),
        // Input 0: the overlay — back-to-back PNGs over loopback TCP from
        // OverlayPacer (image2pipe's png demuxer splits consecutive PNGs
        // on its own). Deliberately NOT stdin: stdin stays free for the
        // 'q' keypress, so Stop ends this process gracefully and the
        // camera driver is released properly instead of TerminateProcess.
        // Tiny probe: the stream is fully described by its first PNG.
        '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(OVERLAY_FPS), '-thread_queue_size', '512',
        '-probesize', '32', '-analyzeduration', '0', ...onProgramClock, '-i', overlayInputUrl,
        // Input 1: mic/capture-card audio (separate dshow input, NOT combined
        // as one "video=X:audio=Y" graph) — 🩹 CONFIRMED IN THE FIELD: the
        // combined syntax failed with "I/O error" the moment video and audio
        // came from two independent physical devices. A small buffer here is
        // genuinely just jitter absorption.
        '-f', 'dshow', '-rtbufsize', '32M', '-thread_queue_size', '64', ...onProgramClock, '-i', `audio=${audioDeviceName}`,
        // Input 2: the camera. cameraMode is resolved by probeCameraMode()
        // FROM THE DEVICE ITSELF (ffmpeg -f dshow -list_options true).
        //
        // -rtbufsize is a LATENCY allowance, not a safety net: at 512M it once
        // held ~27 s of raw frames and the stream ran that far behind. A live
        // feed must DROP late frames, not queue them; "real-time buffer too
        // full, frame dropped" is now counted by the capture meter as a
        // CAPTURE drop — the first failure class, before any encoder.
        //
        // 🛠 -thread_queue_size BOUNDED: it was 512 packets (~2 GB, ~8.5 s at
        // 1080p60 raw) — the size needed to hide the input-clock gap above.
        // With one program clock nothing waits, so half a second is ample.
        '-f', 'dshow', '-rtbufsize', CAMERA_RTBUFSIZE, '-thread_queue_size', String(Math.max(8, Math.ceil((Number(cameraFramerate) || 30) * 0.5))),
        ...onProgramClock,
        ...(cameraVideoSize ? ['-video_size', cameraVideoSize] : []),
        ...(cameraFramerate ? ['-framerate', String(cameraFramerate)] : []),
        '-i', `video=${cameraDeviceName}`,
        '-filter_complex', filterComplex,
        // Output 1: the relay — never displayed, so never re-encoded here.
        // Strict CFR at the program rate: the relay then carries an
        // unambiguous timebase (N frames = N/fps seconds) instead of leaving
        // each consumer to infer one from whatever timestamps arrive.
        '-map', '[vout1]', '-map', '1:a', '-fps_mode', 'cfr', '-r', String(fps), ...RELAY_CONTAINER_ARGS, 'pipe:1',
    ];
    // Output 2: the Program Preview (see MpjpegParser) — a real consumer
    // of the same composited stream, camera+overlay together.
    if (previewOutputUrl) args.push('-map', '[vout2]', '-an', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'mpjpeg', previewOutputUrl);
    // Output 3: the capture meter — never written anywhere.
    if (meter) args.push('-map', '[meter]', '-f', 'null', '-');
    return args;
}

// Same clamp as the live push: recording 60fps out of a 30fps program feed
// writes a file that is half duplicate frames and twice the size, with no
// more motion in it. See effectiveOutputFps.
function buildRecorderEncoderArgs({ width, height, fps, bitrateKbps, outFile, useNvenc, relayFps }) {
    fps = effectiveOutputFps(fps, relayFps);
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
        '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_SAMPLE_RATE_HZ),
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

// 🎯 relayFps — the rate the PROGRAM FEED actually produces. You cannot
// send more real frames than the program feed makes: asking for 60 out of a
// 30fps feed does not produce 60fps of motion, it produces 30fps of motion
// with every frame duplicated. YouTube then sees an uneven cadence and
// judders ("not receiving enough video"), and half the CBR bitrate is spent
// re-sending frames the viewer already has — which is exactly the "20 Mbps
// par bhi lag" report: not a bandwidth problem at all.
//
// So the output rate is min(requested, relay): a HIGHER request is clamped
// to what really exists, a LOWER one still decimates evenly (60 -> 30 keeps
// every other frame, which is correct and cheap). Never duplicate.
// The caller reports the clamp to the operator — it is never silent.
function effectiveOutputFps(requestedFps, relayFps) {
    const req = Number(requestedFps) || 30;
    const relay = Number(relayFps) || 0;
    return relay > 0 ? Math.min(req, relay) : req;
}
function buildLiveEncoderArgs({ width, height, fps, bitrateKbps, keyframeIntervalSec, destinationUrl, useTune, relayWidth, relayHeight, relayFps }) {
    fps = effectiveOutputFps(fps, relayFps);
    const gop = Math.round(fps * keyframeIntervalSec);
    // 🛠 "YouTube is not receiving enough video to maintain smooth
    // streaming" — a SENDING-side problem, not a bandwidth one: the encoder
    // is not delivering frames fast enough to keep the pipe fed.
    //
    // This used to scale UNCONDITIONALLY with flags=lanczos. Two problems:
    //
    //  1. When the relay is already at the streaming resolution (the normal
    //     case — camera, compositor and stream all at 720p or all at 1080p)
    //     the filter still ran, resampling every frame to the size it
    //     already was. Pure waste.
    //  2. On a machine where ffmpeg reports "GPU scale not available" that
    //     resample is CPU swscale, and lanczos is the most expensive kernel
    //     there is — several times bicubic for a difference nobody can see
    //     after a lossy H.264 encode of already-composited frames.
    //
    // So: skip the filter entirely when no resize is needed, and use
    // bicubic when one genuinely is. Visually indistinguishable at this
    // stage, and it hands the frame budget back to the encoder.
    const needsResize = !relayWidth || !relayHeight || relayWidth !== width || relayHeight !== height;
    const scaleArgs = needsResize ? ['-vf', `scale=${width}:${height}:flags=bicubic`] : [];
    return [
        '-hide_banner', '-loglevel', 'warning',
        '-f', 'nut', '-thread_queue_size', '1024', '-i', 'pipe:0',
        ...scaleArgs,
        // Constant frame rate out. RTMP/YouTube expect a steady cadence;
        // an irregular one reads to them as "not enough video" even when
        // the average rate is right.
        '-fps_mode', 'cfr',
        '-r', String(fps),
        '-c:v', 'h264_nvenc',
        '-preset', 'p4', ...(useTune ? ['-tune', 'll'] : []),
        '-rc', 'cbr',
        '-b:v', `${bitrateKbps}k`,
        '-maxrate', `${bitrateKbps}k`,
        '-bufsize', `${bitrateKbps * 2}k`,
        '-g', String(gop), '-keyint_min', String(gop),
        '-bf', '0',
        // Nothing may sit between a frame arriving and it going out:
        // no lookahead buffer, no scene-cut analysis, no encoder delay.
        '-rc-lookahead', '0',
        '-no-scenecut', '1',
        '-delay', '0',
        '-af', 'aresample=async=1:first_pts=0',
        '-c:a', 'aac', '-b:a', '160k', '-ar', String(AUDIO_SAMPLE_RATE_HZ),
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
// 📏 CAPTURE METER — the live first-stage measurement.
//
// Fed by the compositor's own showinfo lines (one per RAW captured frame,
// before any normalization) plus dshow's "real-time buffer too full … frame
// dropped" warnings. It answers, continuously and from evidence, what
// /status used to infer from the RECORDER's output clock — which after the
// relay's CFR grid always reads ~1.0× and so could never reveal a source
// delivering 50 instead of 60, or repeating frames. A CAPTURE drop is
// counted HERE, separately from any encoder/network drop further down.
// ----------------------------------------------------------------
const METER_WINDOW_FRAMES = 600;
class CaptureMeter {
    constructor() { this.reset(); }
    reset() {
        this.ring = [];
        this.totalFrames = 0;
        this.captureDrops = 0;
        this.firstAt = null;
        this.lastAt = null;
        this._cache = null;
    }
    noteFrame(f, wallMs) {
        this.ring.push({ pts: f.pts, checksum: f.checksum, scan: f.scan, wallMs });
        if (this.ring.length > METER_WINDOW_FRAMES) this.ring.shift();
        this.totalFrames++;
        if (!this.firstAt) this.firstAt = wallMs;
        this.lastAt = wallMs;
    }
    noteDrop() { this.captureDrops++; }
    snapshot(expectedFps = null) {
        const now = Date.now();
        if (this._cache && now - this._cache.at < 1000) return this._cache.value;
        const a = this.ring.length >= 10 ? sourceProbe.analyseFrames(this.ring, { warmupSec: 0, expectedFps }) : null;
        const value = {
            totalFrames: this.totalFrames,
            captureDrops: this.captureDrops,
            lastFrameAgoMs: this.lastAt ? now - this.lastAt : null,
            window: a && a.ok ? {
                seconds: a.wallSpanSec, arrivalFps: a.arrivalFps, timestampFps: a.timestampFps,
                timestampHonesty: a.timestampHonesty, jitterMs: a.interval.jitterMs,
                gaps: a.gaps, missingFrames: a.missingFrames, nonMonotonic: a.nonMonotonic,
                repeatedFrames: a.duplicates.count, repeatCycle: a.duplicates.cycle,
                contentFps: a.contentFps, staticContent: a.duplicates.staticContent,
            } : null,
        };
        this._cache = { at: now, value };
        return value;
    }
}

// Plans measured by the source probe, per device + mode + program rate, for
// the life of the engine: a compositor relaunch never re-probes, and a
// restart of preview/recording with the same settings reuses the evidence.
const SOURCE_PLAN_CACHE = new Map();
const LEVEL_TAG_RE = /\[(trace|debug|verbose|info|warning|error|fatal|panic)\] /;

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
        this.cameraMode = null;     // resolved by probeCameraMode(), cached until an open failure invalidates it
        this.interlacedSource = false; // the OPERATOR SELECTED 50i — a request; whether fields are really arriving is measured (sourcePlan)
        this.sourcePlan = null;     // normalization plan: measured by sourceProbe, or derived from the advertised mode
        this.sourceReport = null;   // the full probe report behind it (null when not measured)
        this.negotiated = null;     // the input stream ffmpeg actually opened, read back from its own log
        this.meter = new CaptureMeter();
        this._meterWarned = {};
        // 🎯 CAPTURE TARGET — what to ask the DEVICE for, which is NOT the
        // program format. captureFps differs from the program rate for 50i
        // (25 interlaced frames in, 50 progressive frames out), and the size
        // is a CEILING for the device's own best mode, never a demand to
        // downscale at the card. Set by the caller; null means "the device's
        // best mode, no ceiling".
        this.captureTarget = null; // { fps, width, height } | null
        // 🛠 How hard we are still trying to constrain the camera. dshow
        // refuses an unsupported -video_size/-framerate outright ("Could not
        // set video options" -> I/O error) and ffmpeg exits in under a second,
        // so retrying the SAME mode can never succeed. Each open failure steps
        // this up: 0 = as configured (STREAM_ENGINE_CAMERA_MODE if set, else
        // auto-detect), 1 = ignore the override and auto-detect from what the
        // device advertises, 2 = no constraint at all and let the driver pick.
        this._cameraModeLevel = 0;
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
        this.relayBytesPerSec = frameBytes * fps + AUDIO_SAMPLE_RATE_HZ * 2 * 2;
        this._relaySample = null;   // { at, bytes } — see _sampleRelay
        this.relayMeasuredBytesPerSec = null;
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
                // Skipped once a forced mode has already been rejected by the
                // device — see _cameraModeLevel.
                const override = this._cameraModeLevel === 0
                    ? parseCameraModeOverride(process.env.STREAM_ENGINE_CAMERA_MODE)
                    : null;
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
                const target = this.captureTarget || {};
                // The PROGRAM size is a preference, not a constraint: a mode
                // that matches it exactly needs no scale filter at all, which
                // is the cheapest possible graph — but a bigger mode
                // (controlled downscale) is always preferred over a smaller
                // one (upscale). See pickCaptureMode's tiers.
                const mode = pickCaptureMode(out, {
                    fps: target.fps || this.fps,
                    programWidth: this.width,
                    programHeight: this.height,
                });
                if (mode) {
                    this.log(`[compositor] camera mode auto-detected: ${mode.width}x${mode.height}@${mode.fps}${mode.compressed ? ' (compressed)' : ' (raw)'}`);
                    // An upscale is an upscale whether the source mode was raw or
                    // MJPEG — the picture is just as soft either way. This used to
                    // skip compressed modes, so a card that offers only
                    // mjpeg 1280x720 against a 1080p program went silently upscaled,
                    // which is the same invisible quality loss the raw-mode warning
                    // exists to prevent.
                    if (mode.width < this.width || mode.height < this.height) {
                        this.log(`[compositor] ⚠ the camera is opening BELOW the program resolution (${mode.width}x${mode.height} < ${this.width}x${this.height}) — the feed will be upscaled and look soft. If this device really does support ${this.width}x${this.height}, force it with STREAM_ENGINE_CAMERA_MODE=${this.width}x${this.height}@${this.fps}`);
                    } else if (mode.width > this.width || mode.height > this.height) {
                        // Not a warning: this is the intended path for a
                        // smaller program (e.g. 720x480 out of a 1080p card) —
                        // capture native, downscale once under our control.
                        this.log(`[compositor] camera captures ${mode.width}x${mode.height}, program is ${this.width}x${this.height} — scaling down in the compositor (the card is not asked to do it)`);
                    }
                    // Cadence is judged from the MEASURED source (see
                    // _resolveSourcePlan), not from this advertised rate: a card
                    // that advertises 60 may be carrying a 50 Hz camera.
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
        // Level 2 means every constrained attempt has been refused — open the
        // device with no -video_size/-framerate at all and take whatever it
        // gives, which is better than not opening it.
        if (this._cameraModeLevel >= 2) this.cameraMode = false;
        else if (this.cameraMode === null) this.cameraMode = (await this.probeCameraMode(this._cameraDeviceName)) || false; // false = "probed, nothing usable"
        if (this.stopped) return { ok: false, error: 'Compositor is stopping' };
        if (!this.sourcePlan) await this._resolveSourcePlan();
        if (this.stopped) return { ok: false, error: 'Compositor is stopping' };
        // The overlay renderer is started alongside, never in front of,
        // the camera: if it can't come up, the program feed runs with a
        // transparent overlay and the bridge keeps retrying in background.
        this._startOverlayInBackground();
        const result = await this._spawnLeg();
        if (!result.ok) this.state = 'idle';
        return result;
    }

    // 🔬 MEASURE THE SOURCE BEFORE BUILDING ITS CHAIN — once per device+mode+
    // program rate. A few seconds, before the camera is opened for real (a
    // capture device can only be open once, so this cannot run alongside).
    async _resolveSourcePlan() {
        const mode = this.cameraMode || null;
        const key = `${this._cameraDeviceName}|${mode ? `${mode.width}x${mode.height}@${mode.fps}` : 'auto'}|${this.fps}|${this.interlacedSource ? 'i' : 'p'}`;
        const cached = SOURCE_PLAN_CACHE.get(key);
        if (cached) { this.sourcePlan = cached.plan; this.sourceReport = cached.report; return; }
        let report = null;
        if (SOURCE_PROBE_ENABLED && this._cameraDeviceName) {
            this.log(`[compositor] 🔬 measuring what "${this._cameraDeviceName}" really delivers (${SOURCE_PROBE_SECONDS}s) — real frame rate, timestamps, repeated frames, interlace…`);
            report = await sourceProbe.runProbe({
                spawnFfmpeg: (args, opts) => this.spawnFfmpeg(args, opts, 'source-probe'),
                inputArgs: sourceProbe.dshowInputArgs({ device: this._cameraDeviceName, width: mode && mode.width, height: mode && mode.height, fps: mode && mode.fps }),
                seconds: SOURCE_PROBE_SECONDS, label: this._cameraDeviceName, device: this._cameraDeviceName,
                requested: mode ? { width: mode.width, height: mode.height, fps: mode.fps } : {}, programFps: this.fps,
            });
        }
        let plan;
        if (report && report.measurement.ok && report.plan) {
            plan = { ...report.plan, measured: true };
            for (const line of sourceProbe.formatReport(report).split('\n')) this.log(`[compositor] ${line}`);
            if (this.interlacedSource && !plan.deinterlace) this.log('[compositor] ⚠ 50i was SELECTED, but the frames arriving are progressive (the card or camera has already converted them) — NOT deinterlacing: bobbing progressive frames would halve the vertical detail and double the frame rate into an uneven decimation.');
            if (!this.interlacedSource && plan.deinterlace) this.log(`[compositor] ⚠ the frames arriving are INTERLACED (${plan.deinterlace}) although a progressive mode was selected — deinterlacing them (each field becomes a frame) rather than recording combing.`);
        } else {
            plan = sourceProbe.planFromAdvertised({ deviceFps: mode ? mode.fps : null, programFps: this.fps, interlacedSelected: this.interlacedSource });
            if (report) this.log(`[compositor] ⚠ source probe could not measure the device (${report.measurement.error || 'no frames'}) — chain built from the advertised mode instead: ${plan.chain || 'passthrough'}`);
            for (const n of plan.notes) this.log(`[compositor]   • ${n}`);
        }
        if (WALLCLOCK_TS_OVERRIDE) plan.timestamps = WALLCLOCK_TS_OVERRIDE;
        this.sourcePlan = plan;
        this.sourceReport = report;
        SOURCE_PLAN_CACHE.set(key, { plan, report });
        this.log(`[compositor] camera chain: ${plan.chain || 'passthrough'} → program ${this.fps} fps (${plan.cadence === 'judder' ? '⚠ JUDDER — see above' : 'clean cadence'}); one program clock for camera, audio and overlay${plan.timestamps === 'device' ? ' — OVERRIDDEN to device stamps' : ''}`);
    }

    // Live view of the capture stage for /status.
    captureStatus() {
        const plan = this.sourcePlan;
        const live = this.meter.snapshot(plan && plan.deliveredFps);
        const expected = plan && plan.deliveredFps;
        const w = live.window;
        let verdict = 'measuring';
        const problems = [];
        if (w && w.seconds >= 5) {
            if (expected && Math.abs(w.arrivalFps - expected) / expected > 0.03) problems.push(plan.measured
                ? `device delivering ${w.arrivalFps} fps, ${expected} when measured at start — the HDMI source may have changed; stop and restart preview to re-measure`
                : `device delivering ${w.arrivalFps} fps although it advertises ${expected} — the camera chain was built for ${expected}; enable the source probe (STREAM_ENGINE_SOURCE_PROBE) so it is built from what really arrives`);
            if (Number.isFinite(w.timestampHonesty) && Math.abs(w.timestampHonesty - 1) > 0.01) problems.push(`camera timestamps run at ${w.timestampHonesty}× real time`);
            // The program clock is arrival time; if this PC's clock is coarse
            // (a 15.6 ms Windows tick) the stamps say so here.
            if (w.arrivalFps && w.jitterMs > 250 / w.arrivalFps) problems.push(`camera timestamps jitter ±${w.jitterMs} ms (${Math.round(1000 / w.arrivalFps)} ms frames) — the clock on this PC is coarse or the capture thread is being starved`);
            if (w.missingFrames) problems.push(`${w.missingFrames} frame(s) missing in the last ${w.seconds}s`);
            if (w.nonMonotonic) problems.push(`${w.nonMonotonic} non-monotonic timestamp(s)`);
            verdict = problems.length ? 'warning' : 'ok';
        }
        return {
            requested: this.cameraMode ? { width: this.cameraMode.width, height: this.cameraMode.height, fps: this.cameraMode.fps } : null,
            negotiated: this.negotiated,
            plan, probe: this.sourceReport ? { health: this.sourceReport.health, stages: this.sourceReport.stages, firstProblem: this.sourceReport.firstProblem, at: this.sourceReport.at } : null,
            live, verdict, problems,
        };
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
            interlacedSource: this.interlacedSource,
            sourcePlan: this.sourcePlan,
        });
        this.meter.reset();
        leg.info = '';
        leg.infoDone = false;
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
            const now = Date.now();
            stderrBuf += chunk.toString();
            let idx;
            while ((idx = stderrBuf.search(/[\r\n]/)) >= 0) {
                const raw = stderrBuf.slice(0, idx).trim();
                stderrBuf = stderrBuf.slice(idx + 1);
                if (!raw) continue;
                // 📏 capture meter lines — measured, never printed
                const frame = sourceProbe.parseShowinfoLine(raw);
                if (frame) { this.meter.noteFrame(frame, now); continue; }
                if (/Parsed_showinfo/.test(raw)) continue; // its color_range / config lines
                const lvl = LEVEL_TAG_RE.exec(raw);
                const line = raw.replace(LEVEL_TAG_RE, '');
                if (lvl && (lvl[1] === 'info' || lvl[1] === 'verbose' || lvl[1] === 'debug' || lvl[1] === 'trace')) {
                    // Startup description: read back what ffmpeg REALLY opened.
                    if (!leg.infoDone) {
                        leg.info += line + '\n';
                        if (/Press \[q\]|Output #0/.test(line) || leg.info.length > 20000) {
                            leg.infoDone = true;
                            this._noteNegotiated(sourceProbe.parseInputVideoStream(leg.info, 2)); // input #2 = the camera
                        }
                    }
                    continue;
                }
                if (sourceProbe.CAPTURE_DROP_RE.test(line)) this.meter.noteDrop();
                if (!BENIGN_LINE_RE.test(line)) logLine(line);
                if (/error|failed|cannot|invalid|no space/i.test(line)) this.lastError = line;
            }
            if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
        });

        proc.on('error', (err) => { this.lastError = err.message; });
        proc.on('exit', (code, signal) => this._onLegExit(proc, leg, code, signal));
        return { ok: true };
    }

    // REQUESTED vs NEGOTIATED, from ffmpeg's own description of the input.
    _noteNegotiated(neg) {
        if (!neg) return;
        this.negotiated = neg;
        const req = this.cameraMode;
        this.log(`[compositor] device opened as: ${neg.width}x${neg.height} ${neg.pixFmt || ''} ${neg.codec}${neg.fourcc ? ` (${neg.fourcc})` : ''} @ ${neg.fps || '?'} fps, field order ${neg.fieldOrder}`);
        if (req && (neg.width !== req.width || neg.height !== req.height || (neg.fps && Math.abs(neg.fps - req.fps) / req.fps > 0.02))) {
            this.log(`[compositor] ⚠ FORMAT MISMATCH — asked the device for ${req.width}x${req.height}@${req.fps}, it opened ${neg.width}x${neg.height}@${neg.fps}`);
        }
    }

    _checkMeter() {
        const st = this.captureStatus();
        const w = st.live.window;
        const warnOnce = (key, msg) => { if (this._meterWarned[key] && Date.now() - this._meterWarned[key] < 5 * 60000) return; this._meterWarned[key] = Date.now(); this.log(msg); };
        if (st.live.captureDrops > (this._lastDropsLogged || 0)) {
            warnOnce('drops', `[compositor] ⚠ CAPTURE DROP — ${st.live.captureDrops} frame(s) dropped at the device input so far (the compositor is not keeping up with the camera; this is the FIRST stage, before any encoder or network)`);
            this._lastDropsLogged = st.live.captureDrops;
        }
        if (w && st.problems.length) warnOnce('problems:' + st.problems.join('|').replace(/[\d.]+/g, '#'), `[compositor] ⚠ CAPTURE: ${st.problems.join('; ')}`);
    }

    // MEASURED relay throughput. /status used to report the THEORETICAL
    // bytes/s whenever any data had arrived in the last 5 s — a number that
    // read "healthy" whether the program feed ran at full rate or at half.
    _sampleRelay() {
        const now = Date.now();
        const prev = this._relaySample;
        this._relaySample = { at: now, bytes: this.relay.bytes };
        if (prev && now - prev.at >= 1000 && this.relay.bytes >= prev.bytes) {
            const rate = (this.relay.bytes - prev.bytes) * 1000 / (now - prev.at);
            this.relayMeasuredBytesPerSec = this.relayMeasuredBytesPerSec == null ? rate : this.relayMeasuredBytesPerSec * 0.7 + rate * 0.3;
        }
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
        this._classifyOpenFailure(ranMs);
        this.emit('unexpected-exit', { code, signal, lastError: this.lastError });
        this.state = 'idle';
        if (ranMs >= COMPOSITOR_STABLE_RESET_MS) this._relaunchAttempt = 0;
        this._scheduleRelaunch();
    }

    // 🛠 An input that never opened is not a transient crash — relaunching it
    // unchanged is an infinite loop, and that is exactly what an operator sees:
    // "Error opening input file video=... I/O error" once every 10 seconds,
    // attempt after attempt, with no picture and no explanation.
    //
    // dshow gives two distinct reasons, and they need opposite responses:
    //
    //   • "Could not set video options" — the device does not support the
    //     resolution/framerate being asked for. Retrying it is pointless, but
    //     a DIFFERENT mode will work, so step down the ladder and re-probe.
    //   • device busy / in use — the mode is fine and nothing here can fix it;
    //     something else already holds the camera. Say so plainly instead of
    //     stepping down modes that were never the problem.
    _classifyOpenFailure(ranMs) {
        const err = String(this.lastError || '');
        // Only an IMMEDIATE failure is an open failure; a leg that ran for a
        // while and then died is a genuine crash and keeps the normal retry.
        if (ranMs > 4000) return;
        if (/in use|busy|device or resource/i.test(err)) {
            this.log('[compositor] ⛔ the camera is already open in another program. Nothing here can take it: close the other app (an OBS/vMix source, another Stream Engine window, or a browser tab still holding the camera) and it will connect on the next retry.');
            return;
        }
        if (!/could not set video options|error opening input|i\/o error/i.test(err)) return;

        if (this._cameraModeLevel === 0 && parseCameraModeOverride(process.env.STREAM_ENGINE_CAMERA_MODE)) {
            this._cameraModeLevel = 1;
            this.cameraMode = null;   // force a real probe next time
            this.log(`[compositor] ⛔ the camera REFUSED the forced mode STREAM_ENGINE_CAMERA_MODE=${process.env.STREAM_ENGINE_CAMERA_MODE}. It does not support that resolution/framerate, so retrying it can never work — ignoring it and auto-detecting from what the device actually advertises.`);
            this.log('[compositor]   To keep the forced mode, set it to one of the modes the next "camera offers ..." line lists; to stop forcing it, remove that line from start-native.bat.');
            return;
        }
        if (this._cameraModeLevel <= 1) {
            this._cameraModeLevel = 2;
            this.cameraMode = false;
            this.log('[compositor] ⛔ the camera refused the auto-detected mode too — opening it unconstrained and taking whatever format it gives.');
        }
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
        try { this._checkMeter(); this._sampleRelay(); } catch (e) { /* diagnostics must never take the feed down */ }
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
            relayMBps: this.relayMeasuredBytesPerSec != null && this.relay.lastDataAt && now - this.relay.lastDataAt < 5000 ? Math.round(this.relayMeasuredBytesPerSec / 1e5) / 10 : 0,
            relayExpectedMBps: Math.round(this.relayBytesPerSec / 1e5) / 10,
            // < 1.0 = the compositor is producing the program feed slower than
            // real time (processing can't keep up) — a PROCESSING failure,
            // distinct from a capture drop before it or an encoder backlog after.
            relayRealtimeRatio: this.relayMeasuredBytesPerSec != null ? Number((this.relayMeasuredBytesPerSec / this.relayBytesPerSec).toFixed(3)) : null,
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
    effectiveOutputFps,
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
    pickCaptureMode,
    cadenceCheck,
    parseCameraModeOverride,
    RAW_BANDWIDTH_CAP_BYTES_PER_SEC,
    PREVIEW_FPS,
    PREVIEW_WIDTH,
    previewStep,
    TRANSPARENT_PNG,
    CaptureMeter,
    SOURCE_PLAN_CACHE,
};
