// ================================================================
// 🖼️ OVERLAY BRIDGE — pulls the broadcast overlay (cricket-overlay.html)
// as a continuous stream of PNG frames DIRECTLY from Chromium's own
// renderer via the Chrome DevTools Protocol (Page.startScreencast) —
// NOT via gdigrab, NOT via any OS-level screen/window capture, and NOT
// via a visible window at all. This is what makes the native program
// feed immune to the DirectComposition/GDI-BitBlt incompatibility that
// made gdigrab-based capture unreliable (see stream-engine/README.md).
//
// Chromium's screencast only sends a new frame when the PAGE ACTUALLY
// REPAINTS (a score change, a clock tick, etc.) — a cricket scoreboard
// repaints rarely (maybe a few times a minute), nowhere near a steady
// video frame rate. If we just forwarded those events as-is, ffmpeg's
// image2pipe input would sit with no new bytes between repaints and
// BLOCK reading its stdin — which stalls the whole compositor filter
// graph (camera included, since the overlay filter needs a frame from
// every input to produce an output frame). pipeTo() below solves this
// by re-emitting the LAST KNOWN frame on a steady timer, decoupling
// "how often the overlay visually changes" from "how often the video
// pipeline needs a frame" — the overlay is otherwise a completely
// static image between real repaints, which is exactly correct.
// ================================================================
const { EventEmitter } = require('events');
let puppeteer;
try {
    puppeteer = require('puppeteer-core');
} catch (e) {
    puppeteer = null; // reported via OverlayBridge.available() — see server.js's feature-flag gate
}

function available() {
    return !!puppeteer;
}

class OverlayBridge extends EventEmitter {
    constructor({ execPath, url, width, height }) {
        super();
        this.execPath = execPath;
        this.url = url;
        this.width = width;
        this.height = height;
        this.browser = null;
        this.page = null;
        this.client = null;
        this.stopped = false;
        this.lastFrame = null; // most recent PNG buffer — see pipeTo()
        this.frameCount = 0;
        this.startedAt = null;
        this.lastError = null;
    }

    async start() {
        if (!puppeteer) throw new Error("puppeteer-core is not installed — run 'npm install' in stream-engine/ (see package.json)");
        this.browser = await puppeteer.launch({
            executablePath: this.execPath,
            headless: true,
            args: [
                // Headless rendering doesn't composite through
                // DirectComposition the way an on-screen window does —
                // this isn't the GPU-compositing fix itself (that
                // problem doesn't apply here at all, since nothing ever
                // reads this page's pixels via screen/window capture),
                // it's just keeping this lightweight since the page is
                // a simple HTML/CSS scoreboard, not 3D/WebGL content.
                '--disable-gpu',
                '--no-sandbox',
                '--disable-dev-shm-usage',
                `--window-size=${this.width},${this.height}`,
            ],
            defaultViewport: { width: this.width, height: this.height, deviceScaleFactor: 1 },
        });
        this.page = await this.browser.newPage();
        this.client = await this.page.target().createCDPSession();

        // 🩹 Forces this page to render against a TRANSPARENT backdrop
        // instead of the default opaque white — without this, the
        // composited "overlay" would be a solid rectangle covering the
        // whole camera frame instead of letting the camera show through
        // everywhere the overlay itself doesn't draw graphics.
        await this.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

        await this.page.goto(this.url, { waitUntil: 'networkidle0', timeout: 30000 });

        this.client.on('Page.screencastFrame', (frame) => {
            if (this.stopped) return;
            try {
                this.lastFrame = Buffer.from(frame.data, 'base64');
                this.frameCount++;
                this.emit('frame', this.lastFrame);
            } catch (e) {
                this.lastError = e.message;
            }
            // Ack regardless of whether decoding above succeeded — an
            // un-acked frame pauses Chromium's screencast until the next
            // natural repaint, which would make this bridge fall further
            // and further behind on a real error.
            this.client.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
        });

        await this.client.send('Page.startScreencast', {
            format: 'png', // PNG, not JPEG — JPEG has no alpha channel, and the transparent backdrop above depends on one
            quality: 100,
            maxWidth: this.width,
            maxHeight: this.height,
            everyNthFrame: 1,
        });
        this.startedAt = Date.now();
    }

    // Re-emits the last known frame to `writable` at a steady `fps` —
    // this is what actually keeps a downstream ffmpeg image2pipe input
    // fed continuously; see this file's header comment for why a raw
    // forward of screencast events (repaint-driven, irregular) isn't
    // enough on its own.
    pipeTo(writable, fps = 15) {
        const intervalMs = Math.round(1000 / fps);
        const timer = setInterval(() => {
            if (this.stopped || !this.lastFrame) return;
            if (!writable.writable) return;
            try { writable.write(this.lastFrame); } catch (e) { /* consumer gone — stop() will clear this timer */ }
        }, intervalMs);
        return () => clearInterval(timer); // caller keeps this to unsubscribe this particular consumer
    }

    async stop() {
        if (this.stopped) return;
        this.stopped = true;
        try { if (this.client) await this.client.send('Page.stopScreencast'); } catch (e) { /* already gone */ }
        try { if (this.browser) await this.browser.close(); } catch (e) { /* already gone */ }
    }
}

module.exports = { OverlayBridge, available };
