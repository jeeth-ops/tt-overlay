# AllSportsLive Stream Engine (local, Parts 2 & 3)

## 🧪 Native program feed (opt-in — camera+overlay compositor, no gdigrab)

A second, newer capture architecture exists alongside the gdigrab-based
one described below, built to eliminate the GPU-compositing/gdigrab
incompatibility entirely rather than keep working around it:

```
CAMERA (dshow, opened ONCE) + OVERLAY (Chrome DevTools Protocol
screencast — reads Chromium's renderer directly, never the OS screen)
        ↓
COMPOSITOR (one ffmpeg process)
        ↓ relays the composited frames (uncompressed) out its own stdout
        ├──→ RECORDER-ENCODER (own NVENC session) → master.mp4
        └──→ LIVE-ENCODER (own NVENC session) → RTMPS → YouTube
```

See `nativePipeline.js` and `overlayBridge.js` for the implementation,
and their header comments for the full reasoning (in particular: why a
physical camera can only be opened once, and how recording/streaming
stay fully independent anyway).

**This has NOT been field-verified** the way the gdigrab path below has
(many rounds of real-hardware fixes). It was built and syntax-checked in
an environment with no Windows machine, GPU, or camera to test against.
It is **off by default** — the gdigrab path remains what actually runs
unless you opt in.

### Trying it

```
cd stream-engine
npm install                 # pulls in puppeteer-core, needed for the overlay bridge
set NATIVE_PROGRAM_FEED=true
npm start
```

`GET /status` reports `nativeProgramFeed: true` and a `compositor`
object (`state`/`matchId`/`refs`/`lastError`) when it's on. The Cricket
Panel adapts automatically: the camera dropdown switches from browser
`getUserMedia` devices to the Stream Engine's own `GET /video-devices`
(native dshow device names), and there is no Live Output browser window
to open at all — `ensureLiveOutputWindow()` just confirms a camera is
selected and starts the native preview.

### Known gaps (be aware before relying on this for a real match)

- **Program-feed health check is simplified.** The gdigrab path's
  blackdetect/negate+blackdetect/freezedetect check doesn't apply here
  (there's no window to sample) — the native path currently only checks
  that the compositor's preview snapshot exists and is recent/non-tiny,
  which does NOT actually detect an all-black or all-white frame.
- **One match at a time.** A second match's compositor can't run
  alongside a first — same limitation the existing recorder already has.
- **dshow format negotiation isn't probed.** If a camera doesn't support
  the exact requested resolution/framerate combo, the compositor will
  fail to start with ffmpeg's own error rather than falling back to a
  supported format automatically.
- **Overlay transparency** depends on Chrome DevTools Protocol's
  `Emulation.setDefaultBackgroundColorOverride` actually producing an
  alpha channel through `Page.startScreencast`'s PNG frames in practice
  — implemented per the documented CDP behavior, not yet confirmed
  against a real Chromium build.

### Long-run reliability (6–7 hour matches)

What keeps recording, streaming and clipping independent and stable
for a full match (details in the header comments of `nativePipeline.js`
and `server.js`):

- **Relay isolation.** The compositor's NUT relay is cut into whole
  packets at NUT syncpoints. The recorder and live encoder each join
  at the next packet (header + packets, no stale replay, no compositor
  restart), fall behind by skipping whole packets (memory stays
  bounded, timeline stays in sync), and are stopped on a packet
  boundary (no `Invalid buffer size … Error submitting packet` on Stop).
  An ABR restart or YouTube reconnect never touches the recording.
- **Overlay pacing is wall-clock exact** and the overlay comes in over
  loopback TCP, so the overlay can never slow the camera feed down, and
  the compositor can be stopped gracefully (`q`) so the camera driver
  is released properly.
- **Program Preview is kept in memory** (`GET /capture-preview`), not
  rewritten to a JPEG on disk twice a second — a file-lock on that
  JPEG used to kill the whole compositor.
- **Watchdogs check real progress, not just "process alive":** the
  compositor restarts itself if it produces no video for 10s; the
  recorder is restarted into a new segment if its output time or file
  size stops advancing for 30–45s while the feed is live; the live
  encoder reconnects if its output stops for 30s. Only the affected
  part restarts.
- **Clip jobs** have frozen per-job windows (T0−15s → T0+5s), wait until
  the recording has actually written the window's end, run in a queue
  (max 2 cuts at once, below-normal priority, 120s timeout), retry up to
  3 times, and never block the next clip, the recorder or the stream.
- **Nothing blocks the event loop** during a match (no sync ffprobe /
  nvidia-smi / `ffmpeg -version` per poll, no sync job-file writes), and
  progress lines are parsed rather than printed.
- **Clean shutdown:** Ctrl+C / closing the window stops live → recorder
  → compositor → Chromium in order, waits for each, and leaves no
  ffmpeg behind; any orphan from a crashed previous run is reaped at
  the next start. QuickEdit is disabled for the engine's console window
  (a click in it would otherwise freeze the engine).
- A `[health]` line is logged every 10 minutes while anything runs, and
  `GET /status` → `resources` / `compositor.relay` / `clipQueue` show
  memory, child processes, relay consumers and the clip queue live.

If you hit any of these, the gdigrab path (`NATIVE_PROGRAM_FEED` unset
or `false`) is the fallback — nothing about it changed.

---

> **Note:** this file predates the current native-capture architecture in
> `server.js` (gdigrab + dshow → NVENC, no MediaRecorder/`/ingest` in the
> video path — see `server.js`'s own header comment for the authoritative,
> up-to-date description). The sections below about `/ingest` and
> `localBuffer.js` describe an earlier design and are kept for history;
> don't rely on them for how video actually flows today.

## Native preview showing black/white — root cause + fix

If the "Preview Native Capture (gdigrab)" image, or the live YouTube
output itself, came back solid black or solid white even though Live
Output looked correct on screen, this was almost always the actual
`window.open()` popup path: Chromium composites a GPU-accelerated window
through DirectComposition, and gdigrab's capture is classic GDI `BitBlt`,
which cannot read a DirectComposition swapchain — it gets back whatever's
behind/around it, typically solid white or black, even though a human
looking at the same window sees it rendering perfectly. `window.open()`
out of the Cricket Panel's own already-running (already GPU-accelerated)
browser process can never turn GPU compositing off for just that one
popup — Chromium flags only take effect when a **new process** launches.

The fix: the Stream Engine now launches Live Output itself, as its own
dedicated Chromium process, with `--disable-gpu` (see
`launchCaptureWindow`/`resolveCaptureBrowserExecutable` in `server.js`)
— the same "disable GPU" setting vMix documents for its own embedded-
Chromium Browser Input when a capture path needs to read pixels
directly. `cricket-panel.html`'s `ensureLiveOutputWindow()` calls
`POST /capture-window/launch` for this and only falls back to the old
`window.open()` popup if a Chrome/Edge install can't be found (set
`CAPTURE_BROWSER_PATH` to its full `.exe` path if it's in a non-standard
location) or the OS isn't Windows.

**Confirmed in the field:** `--disable-gpu` alone was not enough — a
live `<video>` element (the camera feed) can render through a SEPARATE
DirectComposition "video overlay" swapchain, independent of the general
page compositor that flag controls. That made the window look correct
on screen (camera + overlay both visible) while gdigrab/`/capture-preview`
still came back blank right where the `<video>` element was. Fixed by
also passing `--disable-features=DirectCompositionVideoOverlays`.

On top of that fix, two more layers exist specifically so a bad feed is
never silently sent live:

- **A native preview that mirrors the real capture** — the panel's
  "Native Preview" image polls `GET /capture-preview` (an actual gdigrab
  frame, the same path the encoder uses), not the browser tab's own DOM
  render of `live-output.html`, which can look fine even when gdigrab
  itself sees a blank surface.
- **An automatic program-feed health check** — `POST /go-live` samples
  ~1.4s of the real capture through ffmpeg's own `blackdetect`/
  `freezedetect` filters (`GET /program-feed-health` exposes the same
  check on demand) and refuses to start the stream if it comes back
  solid black or solid white, returning a `PROGRAM OUTPUT ERROR` instead.
  A background sampler (`monitorProgramFeedHealth`, every ~30s) keeps
  watching while live/recording and surfaces the result via `/health`.

A small local service that runs **on the operator's own PC**, next to the
Cricket Panel browser tab. One browser capture (camera + the existing
Cricket Overlay, composited in `../live-output.html`), two jobs, fed by
the exact same incoming bytes:

1. **Streaming (Part 2):** encode with the GPU (NVIDIA NVENC) and push to
   YouTube over RTMPS.
2. **Clips (Part 3):** also write into a local rolling buffer
   (`localBuffer.js`) that the *existing, unmodified* clip logic in
   `cricket-panel.html` (recordBall/triggerWicketClip — FOUR/SIX/wide/
   no-ball/bye/leg-bye/every wicket type) now reads from instead of
   vMix's recording file. This engine implements the same local HTTP
   contract (`/status`, `/recording-start`, `/recording-stop`, `/clip`)
   ClipperHelper.exe used to — **zero runtime dependency on vMix**.

It never runs on Render. No 1080p video ever touches `server.js`, Mongo,
or Socket.IO — only short finished clip files (via the existing
`/api/clips/ingest`, same as ClipperHelper.exe always used) and ordinary
score/control traffic (socket.io) reach it. See the Part 2/3 reports for
the exact data/video flow.

## Requirements

- Node.js 18+
- An **NVENC-capable ffmpeg build** (+ its matching ffprobe). The
  `@ffmpeg-installer/ffmpeg` package used elsewhere in this repo (for
  clip cutting) is a **minimal build without hardware encoders** — it
  will NOT work here. **Preferred: bundle it** — put `ffmpeg.exe` and
  `ffprobe.exe` in `stream-engine/bin/` (see `bin/README.md` for exactly
  what to download) and the engine finds them automatically; the
  operator never installs ffmpeg system-wide or touches PATH at all.
  `FFMPEG_PATH`/`FFPROBE_PATH` env vars, then system PATH, are only
  fallbacks if `bin/` is empty.
- An NVIDIA GPU + driver that supports NVENC (RTX 3050 does).
- Google Chrome or Microsoft Edge installed at one of the usual Windows
  install paths (or set `CAPTURE_BROWSER_PATH` to its full `.exe` path).
  Used to launch Live Output as a dedicated, GPU-compositing-disabled
  process — see "Native preview showing black/white" above. If neither
  is found, the panel falls back to a `window.open()` popup, which does
  NOT get this fix.

## Setup

```
cd stream-engine
npm install
:: copy ffmpeg.exe + ffprobe.exe into stream-engine\bin\ — see bin\README.md
npm start
```

`FFMPEG_PATH`/`FFPROBE_PATH` env vars (e.g. `set FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe`)
are only needed if you're deliberately NOT bundling — see `bin/README.md`.

Runs at `http://127.0.0.1:5006` — bound to localhost only, not reachable
from Render or the network.

## Verifying NVENC before match day

```
curl http://127.0.0.1:5006/status
```

`nvencAvailable` must be `true`. If it's `false`, `nvencDetail` explains
why (ffmpeg not found, or found but built without `h264_nvenc`). `/go-live`
refuses to start at all when this is false — it will never silently fall
back to CPU (`libx264`) encoding.

Also check `ffmpegSource`/`ffprobeSource` — should read `"bundled"` if
you followed `bin/README.md`. `"system PATH"` or an env-var source means
this machine is depending on something outside this app's own folder,
which won't travel with it if you move/reinstall Stream Engine
elsewhere. `ffprobeAvailable: false` means clip/recording integrity
checks (see `verifyMediaFile` in `server.js`) are silently disabled —
worth fixing before match day, not just NVENC.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | ffmpeg/NVENC/stream-key/encoder/clip-engine readiness |
| POST | `/set-stream-key` | `{streamKey}` — stored locally only, never echoed back |
| POST | `/go-live` | `{resolution, fps, bitrateKbps}` — starts the NVENC→RTMPS push |
| POST | `/ingest?matchId=&index=` | raw webm bytes from the panel's MediaRecorder — fed to the local clip buffer AND (if live) the encoder |
| POST | `/stop` | gracefully ends the YouTube stream (encoder only) |
| GET | `/health` | live bitrate/fps/dropped-frames/duration/state + clip engine state |
| POST | `/recording-start` | `{matchId, tournamentId, mainServerUrl}` — starts the local clip buffer for a match |
| POST | `/recording-stop` | `{matchId}` — stops it (buffer is kept ~90s for in-flight clips, then deleted) |
| POST | `/clip` | `{eventType, timestamp, matchId, ballMeta}` — cuts a clip from the local buffer, forwards it to `mainServerUrl`'s `/api/clips/ingest` |
| POST | `/set-folder` | legacy no-op — kept so older UI calls don't break; Drive/R2 folder routing is handled entirely by server.js now |

### Native capture / program-feed endpoints (current, accurate)

| Method | Path | Purpose |
|---|---|---|
| GET | `/capture-preview?matchId=` | one real gdigrab frame as a PNG — same path the recorder/encoder use |
| GET | `/program-feed-health?matchId=` | on-demand black/white/frozen sample of the real capture (see "Native preview showing black/white" above) |
| GET/POST | `/capture-config` | get/set the gdigrab crop margins (`cropTop`/`cropBottom`/`cropLeft`/`cropRight`) |
| POST | `/capture-window/launch` | `{matchId, videoDeviceId, origin, width, height}` — launches Live Output as a dedicated, GPU-compositing-disabled Chromium process |
| POST | `/capture-window/close` | closes that dedicated process |
| GET | `/capture-window/status` | whether it's running + last reported camera-ended reason |
| POST | `/capture-window/camera-ended` | `live-output.html` reports here directly when its camera track ends/has no signal |

## Clip engine (Part 3)

- **Source:** `localBuffer.js` — a segmented, per-match rolling buffer
  under `buffer/matches/<matchId>/{recordings,clips,temp}`, retaining the
  last 90s of footage (comfortably more than the 10s pre-roll / 10s
  post-roll every clip actually needs) — never the whole match, so disk
  use stays bounded across a multi-hour match.
- **Pre-roll/post-roll:** unchanged from Part 1 — 10s / 10s.
- **Duplicate prevention:** a repeat `/clip` call for the same
  matchId+eventType+timestamp (double click, client retry, even
  genuinely concurrent requests) is deduped to a single cut+upload.
- **Cloudflare failure ≠ lost clip:** if forwarding to `mainServerUrl`
  fails, the local `.mp4` is kept and retried with backoff
  (`retry-queue.local.json` persists the queue across a restart of this
  process) — never silently discarded.
- **Multi-match isolation:** every match's buffer/clips live under their
  own `matchId` folder; a clip request always reads only that match's
  chunks.

## Failure handling

- Unexpected ffmpeg exit while a stream is meant to be live is treated as
  a crash: auto-restarted up to 3 times within a 5-minute window (with
  backoff), then gives up and surfaces `state:"crashed"` via `/health`
  for the panel to show as an error.
- Pressing "Stop Stream" in the panel is the expected/graceful path — no
  restart is attempted for that.
- A crash here never takes down this Node process itself (see the
  `uncaughtException` handler in `server.js`) — the panel keeps polling
  `/health` and can retry.
