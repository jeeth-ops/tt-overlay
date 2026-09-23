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
// REPAINTS (a score change, a clock tick, etc.) — nowhere near a steady
// video frame rate. This bridge just keeps the latest frame ('frame'
// events); nativePipeline.js's OverlayPacer re-sends it to ffmpeg at a
// wall-clock-exact rate, which is what keeps the compositor's overlay
// input (and therefore the whole program feed) advancing in real time.
//
// If Chromium itself dies mid-match, 'disconnected' fires so the
// compositor can bring up a fresh bridge while the pacer keeps sending
// the last good frame — the program feed never notices.
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
        this.lastFrame = null; // most recent PNG buffer (also emitted as 'frame')
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
        if (this._stopped) { await this._closeBrowser(); throw new Error('overlay bridge stopped while starting'); }
        this.browser.on('disconnected', () => {
            if (!this.stopped) {
                this.stopped = true;
                this.emit('disconnected');
            }
        });
        this.page = await this.browser.newPage();
        // A crashed renderer (tab "Aw, Snap") leaves the browser running
        // but frames stop — reload the page instead of freezing the overlay.
        this.page.on('error', (err) => {
            if (this.stopped) return;
            this.lastError = `overlay page crashed: ${err.message}`;
            console.log(`[overlay] ${this.lastError} — reloading`);
            this.page.reload({ waitUntil: 'load', timeout: 30000 }).catch(() => {});
        });
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

    // Never hangs: browser.close() is given a few seconds, then the
    // Chromium process is killed outright so a wedged renderer can't
    // block a Stop/shutdown or be left behind as an orphan.
    async stop() {
        if (this._stopped) return;
        this._stopped = true;
        this.stopped = true;
        await this._closeBrowser(); // no-op if start() hasn't launched it yet — start() closes it itself then
    }

    async _closeBrowser() {
        const browser = this.browser;
        if (!browser || this._closing) return;
        this._closing = true;
        const proc = typeof browser.process === 'function' ? browser.process() : null;
        try { if (this.client) await Promise.race([this.client.send('Page.stopScreencast'), new Promise((r) => setTimeout(r, 1000))]); } catch (e) { /* already gone */ }
        const closed = await Promise.race([
            browser.close().then(() => true, () => false),
            new Promise((r) => setTimeout(() => r(false), 4000)),
        ]);
        if (!closed && proc && proc.exitCode === null) { try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ } }
    }
}

module.exports = { OverlayBridge, available };
