# AllSportsLive Stream Engine — native capture architecture

A small local service that runs **on the operator's own PC** (Windows),
next to the Cricket Panel browser tab. This is a **native, broadcast-style
media engine**, not a browser video pipeline: the browser never captures,
encodes, chunks or uploads video. It only renders the picture
(`../live-output.html`, unchanged) and drives this engine's plain JSON
control API (start/stop/status/clips).

```
CAMERA (getUserMedia, live-output.html)
        +
CRICKET OVERLAY (cricket-overlay.html, iframe, live-output.html)
        │  (composited by the browser's own DOM/GPU rendering —
        │   exactly like an OBS/vMix "Browser Source")
        ▼
  live-output.html window, on screen
        │
        │  captured NATIVELY, at the OS level — no browser video
        │  encode, no Blob, no WebM, no HTTP upload of video bytes
        ▼
┌───────────────────────────────────────────────────────────────┐
│  TWO INDEPENDENT native ffmpeg processes, each doing its OWN   │
│  gdigrab (window) + dshow (audio device) capture:              │
│                                                                 │
│   RECORDER            LIVE ENCODER                              │
│   gdigrab+dshow        gdigrab+dshow                             │
│   → NVENC (fixed hi-Q) → NVENC (ABR bitrate/res)                │
│   → master.mp4          → RTMPS → YouTube                      │
└───────────────────────────────────────────────────────────────┘
        │
        ▼  (clip cut STRICTLY from master.mp4 — see below)
StreamEngineData/Clips/<matchId>/<clipId>.mp4
        │
        ├─→ local Clips folder (kept until R2+Drive both confirm)
        └─→ forwarded to server.js's EXISTING /api/clips/ingest
              → EXISTING Cloudflare R2 / Google Drive / Mongo pipeline
```

It never runs on Render. No video ever touches `server.js`, Mongo, or
Socket.IO — only short finished clip files (via the existing
`/api/clips/ingest`) and ordinary score/control traffic (socket.io) reach
it.

## Why this replaced the old browser/MediaRecorder pipeline

A previous version of this engine had the browser do `getDisplayMedia()`
on the Live Output window, software-encode it to WebM with
`MediaRecorder`, and POST 1-second chunks over HTTP into this process,
which piped the raw bytes into ffmpeg's `stdin`. That made the **browser**
the video encoder and the video transport — never true real-time/CFR (DOM
rendering, tab throttling and JS-timer jitter are not a hardware media
clock), and it was the direct cause of two real bugs: chunks silently
dropped under backpressure, and unordered/unretried chunk delivery — both
of which spliced gaps into the WebM container ffmpeg was demuxing,
reaching YouTube as glitches/freezes/torn connections. See git history for
the full diagnosis of that version if useful context.

**This version removes that pipeline entirely.** ffmpeg captures the
Live Output window's rendered pixels directly (Windows GDI screen/window
capture — `gdigrab`) and the mic/capture-card audio directly (`dshow`) —
no MediaRecorder, no Blob, no WebM, no HTTP chunk relay anywhere in the
production path. There is no `/ingest` route.

## Why two independent ffmpeg processes, not one fanned out

The recorder and the live encoder are two **fully separate** ffmpeg
processes, each doing its own gdigrab+dshow capture, rather than one
capture fanned out to two outputs. This is a deliberate reliability
choice: **local recording must never depend on YouTube/network** (a
reconnect, an ABR hot-restart, or a crash in the live encoder must never
touch the recorder). A single process with two outputs (e.g. ffmpeg's
`tee` muxer) can't fully guarantee that — a stalled/blocked network
socket on one output can back up shared internal queues and affect the
other. Two independent processes have no such coupling at all.

This does mean the same on-screen window (and the same audio device) is
read by two processes at once. That is safe here specifically because:
- **Screen/window capture (`gdigrab`) is a shared OS read**, not an
  exclusive hardware device — unlike a physical capture card, which
  usually only allows one process to open it. The actual camera hardware
  is opened exactly **once**, by the browser tab's own `getUserMedia`
  inside `live-output.html` — ffmpeg never touches the camera device
  directly, only the window's rendered pixels.
- Audio device sharing (two ffmpeg processes both opening the same
  `dshow` mic/capture-card input) generally works under Windows' default
  shared-mode audio capture, but **this is the one piece of this design
  that most needs verification on the real operator machine** — see
  "What needs verifying on real hardware" below. If it turns out not to
  work on a specific device, the standard fix is a virtual audio cable
  (e.g. VB-CABLE) that duplicates the physical input into two virtual
  endpoints — operator-side setup, outside this codebase.

## Requirements

- **Windows.** `gdigrab`/`dshow` are Windows-only ffmpeg demuxers — this
  engine reports `nativeCaptureSupported: false` via `/status` and refuses
  to start capture on any other OS rather than failing with a confusing
  ffmpeg error. (macOS would need `avfoundation`, Linux `x11grab` +
  `pulse`/`alsa` — not implemented.)
- Node.js 18+
- An **NVENC-capable ffmpeg build**. Install a full build, e.g. the "full"
  Windows build from https://www.gyan.dev/ffmpeg/builds/ (ships
  `h264_nvenc`, and ideally `hwupload_cuda`/`scale_npp` for GPU-accelerated
  scaling — see "GPU pipeline" below), and either:
  - put it on your system `PATH`, or
  - set the `FFMPEG_PATH` environment variable to its full path.
- An NVIDIA GPU + driver that supports NVENC.

## Setup

```
cd stream-engine
npm install
set FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe   (Windows, if not on PATH)
npm start
```

Runs at `http://127.0.0.1:5006` — bound to localhost only, not reachable
from Render or the network.

## Verifying before match day

```
curl http://127.0.0.1:5006/status
```

Check: `nativeCaptureSupported` (must be `true` — Windows), `nvencAvailable`
(must be `true` — `/go-live` refuses to fall back to CPU encoding if not),
`gpuScaleAvailable` (informational — see "GPU pipeline" below).

**Before going live, open the Live Output window from the panel, then use
its "🖼️ Preview Native Capture" button** (calls `GET /capture-preview`).
This grabs one real frame through the exact same gdigrab path Go Live
uses, so you can *see*: (a) that it actually finds the window by title,
and (b) whether the crop margin (`captureConfig` — see below) is trimming
the OS title bar correctly rather than eating into the picture. This is
the one check that genuinely cannot be verified without the real Windows
machine, so it's built as a concrete, operator-runnable diagnostic rather
than just asserted to work.

### Crop margin (`captureConfig`)

gdigrab's window-title mode captures the **whole window**, including the
OS title bar and borders (there is no browser API for a fully chromeless
popup). `GET/POST /capture-config` (`cropTop`/`cropBottom`/`cropLeft`/
`cropRight`, default `cropTop: 32`) strips that margin before scaling to
the target resolution. Exact title-bar height varies by Windows version,
display scaling (DPI) and theme — use `/capture-preview` to tune this for
your machine once, not per match.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | platform/ffmpeg/NVENC/GPU-scale/stream-key/network/recorder readiness |
| GET | `/audio-devices` | native dshow audio device names (panel's microphone dropdown) |
| GET/POST | `/capture-config` | crop margin for the gdigrab window capture |
| GET | `/capture-preview?matchId=` | one JPEG frame via gdigrab — visual pre-flight check |
| POST | `/set-youtube-config` | `{streamUrl, streamKey}` — stored locally only, key never echoed back |
| POST | `/go-live` | `{resolution, fps, bitrateKbps, matchId, audioDeviceName, ...}` — starts the native capture → NVENC → RTMPS push |
| POST | `/stop` | gracefully ends the YouTube stream (live encoder only) |
| GET | `/health` | live bitrate/fps/dropped-frames/GPU-encoder-status/duration/state |
| POST | `/recording-start` | `{matchId, tournamentId, mainServerUrl, audioDeviceName, ...}` — starts the native capture → NVENC → `master.mp4` recorder |
| POST | `/recording-stop` | `{matchId}` — stops the recorder (`master.mp4` itself is never touched by anything else) |
| POST | `/clip` | `{eventType, timestamp, matchId, ballMeta}` — cuts a clip **directly from `master.mp4`**, forwards it to `mainServerUrl`'s `/api/clips/ingest` |
| GET | `/clip-jobs`, `/clip-jobs/:clipId` | per-clip live status |
| GET/POST | `/adaptive-config` | ABR ladder/thresholds |
| POST | `/set-folder` | legacy no-op — kept so older UI calls don't break |

There is deliberately **no `/ingest` route** — no video bytes of any kind
cross this HTTP API in either direction.

## Clip engine

- **Source: `master.mp4`, strictly.** Clips are cut with
  `ffmpeg -ss <offset> -i <StreamEngineData/Recordings/<matchId>/master.mp4> -t <duration>`,
  writing into `StreamEngineData/Clips/<matchId>/<clipId>.mp4`. Never
  YouTube, never HLS/m3u8, never a browser blob/chunk, never R2/Drive
  (those are upload destinations only).
- **Pre-roll/post-roll:** 15s / 5s (`CLIP_PRE_ROLL_SEC`/`CLIP_POST_ROLL_SEC`
  in `server.js`).
- **Duplicate prevention:** a repeat `/clip` call for the same
  matchId+eventType+timestamp is deduped to a single cut+upload.
- **Cloudflare/Drive failure ≠ lost clip:** if forwarding to
  `mainServerUrl` fails, the local `.mp4` is kept and retried with backoff
  (`retry-queue.local.json` persists the queue across a restart of this
  process). The local copy is only deleted once `server.js` confirms BOTH
  R2 and Drive have it.
- **Never re-encodes the whole match:** `-ss` before `-i` seeks to the
  nearest keyframe (2s GOP) and only the ~20s window is decoded/encoded.

## GPU pipeline

- **Encoding** (recorder + live push + clip cutting): NVENC always
  preferred; falls back to `libx264` (CPU) only if a real throwaway NVENC
  encode fails on this machine (`checkNvencRuntime`) — never assumed just
  because the build lists the encoder.
- **Scaling** (crop/resize between capture and encode): prefers
  `hwupload_cuda` + `scale_npp` (frames stay on the GPU end-to-end, no
  GPU→CPU→GPU round trip) — but ONLY if a real throwaway encode through
  that exact filter chain succeeds (`checkGpuScaleRuntime`); falls back to
  CPU `swscale` with a clearly logged reason otherwise. `/status`'s
  `gpuScaleAvailable` and `/health`'s `encoder.gpuScaleAccelerated` report
  which path is actually active — never just assumed.
- Cropping/scaling a screen capture is comparatively cheap either way; the
  stage that actually matters for CPU load — encoding — is on the GPU via
  NVENC regardless of which scale path is active.
- `/health`'s `gpu`/`cpuPercent` (best-effort `nvidia-smi` + cross-platform
  CPU sampling) let you confirm the GPU, not the CPU, is doing the work.

## Network adaptation (ABR)

Unchanged in spirit from before: a fast, rate-limited hot-restart of the
**live encoder only** (stop that one process, start a new one with a
lower bitrate/resolution) when `sampleNetworkHealth()` — now driven by
ffmpeg's own `-progress` output (achieved bitrate vs. target, dropped
frames, and ffmpeg's own real-time `speed=` factor) since there is no
Node-side stdin pipe to measure backpressure on anymore — reports
sustained congestion. Hysteresis (`holdWeakSec`/`holdCriticalSec`/
`holdStableUpSec`) prevents thrashing; the recorder is a fully separate
process and is never restarted by this. Tunable via `/adaptive-config`.

## Failure handling

- Unexpected ffmpeg exit while a stream/recording is meant to be running
  is treated as a crash: auto-restarted up to 3 times within a 5-minute
  window, then gives up and surfaces `state:"crashed"` for the panel to
  show as an error.
- The Live Output window being closed/not found (`gdigrab`'s "window not
  found") is treated as a **fatal, operator-actionable** error — never
  the unlimited-backoff network-reconnect loop, which is reserved for
  genuine connectivity problems.
- Pressing "Stop" is the expected/graceful path — ffmpeg is asked to quit
  cleanly (the interactive `q` keypress on its stdin — the correct way to
  stop ffmpeg on Windows, where `child_process.kill()` can only force-kill
  regardless of signal name) before a `SIGKILL` fallback.
- A crash here never takes down this Node process itself — the panel
  keeps polling `/health`/`/status` and can retry.

## What needs verifying on real hardware

This was implemented and reasoned through carefully, but **could not be
run against a real Windows machine, camera, GPU, or live YouTube ingest
from this environment** — do not treat it as field-proven until you've
run through this list on the actual operator PC:

1. **`gdigrab` window-title targeting** actually finds `live-output.html`
   reliably by its `document.title` (`AllSportsLive-LiveOutput-<matchId>`)
   — check via `/capture-preview` before every match, not just once.
2. **GPU-accelerated screen content via `gdigrab`** — Chrome's hardware
   video/WebGL compositing can, on some Windows/driver combinations, not
   render correctly through BitBlt-based window capture. `/capture-preview`
   is exactly the check for this; if the preview looks wrong (black,
   stale, or missing the camera), try disabling hardware acceleration for
   that Chrome window, or ffmpeg's newer `ddagrab` (Desktop Duplication
   API) demuxer if your build has it.
3. **Simultaneous `dshow` audio capture by two processes** (recorder +
   live encoder) from the same physical device — see "Why two independent
   processes" above for the fallback (a virtual audio cable) if this
   doesn't work on a given device/driver.
4. **The crop margin default** (`cropTop: 32`) is a reasonable Windows
   10/11 @100% DPI guess, not a measurement — tune it with
   `/capture-preview` for your actual display scaling.
5. **`scale_npp`/`hwupload_cuda` availability** on the operator's actual
   ffmpeg build/driver — `checkGpuScaleRuntime()` probes this and falls
   back safely, but confirm `gpuScaleAvailable` reads `true` if you expect
   the GPU scale path.
6. A full end-to-end run of the acceptance tests below, on the real
   15–20 Mbps connection this was built for.

## Suggested acceptance tests (run these before trusting it on match day)

1. 1080p30 @ stable 20 Mbps, 15 Mbps, and 15 Mbps fluctuating upload —
   smooth stream, no reconnect loops.
2. Disconnect internet 5–10s mid-stream — YouTube reconnects, `master.mp4`
   never stops growing.
3. Cut a clip while internet is down — local `.mp4` appears immediately;
   R2/Drive show `PENDING` until internet returns, then upload without
   re-cutting.
4. Close the Live Output window mid-stream — engine reports a clear
   "window not found" error, not an infinite reconnect loop.
5. Open `master.mp4` and a cut clip independently in VLC — both contain
   camera + overlay + audio, in sync.
6. `grep` the clip-generation code path (`cutLocalClip`/`cutFromMasterFile`
   in `server.js`) — confirm zero references to YouTube, HLS, m3u8, R2, or
   Drive as a *source*.
