# AllSportsLive Stream Engine (local, Parts 2 & 3)

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
- An **NVENC-capable ffmpeg build**. The `@ffmpeg-installer/ffmpeg` package
  used elsewhere in this repo (for clip cutting) is a **minimal build
  without hardware encoders** — it will NOT work here. Install a full
  build instead, e.g. the "full" Windows build from
  https://www.gyan.dev/ffmpeg/builds/ (ships `h264_nvenc`), and either:
  - put it on your system `PATH`, or
  - set the `FFMPEG_PATH` environment variable to its full path.
- An NVIDIA GPU + driver that supports NVENC (RTX 3050 does).

## Setup

```
cd stream-engine
npm install
set FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe   (Windows, if not on PATH)
npm start
```

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

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | ffmpeg/NVENC/stream-key/encoder/clip-engine readiness |
| POST | `/set-stream-key` | `{streamKey}` — stored locally only, never echoed back |
| POST | `/go-live` | `{resolution, fps, bitrateKbps}` — starts the NVENC→RTMPS push |
| POST | `/ingest?matchId=&index=` | raw webm bytes from the panel's MediaRecorder — fanned out to: the local master recorder (always), the local clip buffer/header-priming store (always), and (if live) the YouTube encoder |
| POST | `/stop` | gracefully ends the YouTube stream (encoder only) |
| GET | `/health` | live bitrate/fps/dropped-frames/encoder-pipe-buffered-bytes/duration/state + clip engine state |
| POST | `/recording-start` | `{matchId, tournamentId, mainServerUrl}` — starts the local full-match master recording (`master.mp4`) AND the header-priming buffer for a match |
| POST | `/recording-stop` | `{matchId}` — stops the master recording; the header-priming buffer is kept ~90s for any clip still in flight, then deleted (`master.mp4` itself is never touched by this) |
| POST | `/clip` | `{eventType, timestamp, matchId, ballMeta}` — cuts a clip **directly from the local `master.mp4`**, forwards it to `mainServerUrl`'s `/api/clips/ingest` |
| POST | `/set-folder` | legacy no-op — kept so older UI calls don't break; Drive/R2 folder routing is handled entirely by server.js now |

## Clip engine (Part 3)

- **Source: the local master recording, strictly.** Clips are cut with
  `ffmpeg -ss <offset> -i <StreamEngineData/Recordings/<matchId>/master.mp4> -t <duration>`,
  writing straight into `StreamEngineData/Clips/<matchId>/<clipId>.mp4`.
  **Never** `localBuffer.js`'s rolling WebM chunk buffer, never YouTube,
  never HLS/m3u8, never a browser blob. (An earlier version of this
  engine *did* stitch clips together from `localBuffer.js`'s independent
  MediaRecorder chunks — that was fragile by construction: any one
  dropped/reordered chunk corrupted the reconstructed WebM and either
  produced a broken clip or, worse, was silently fed to the live YouTube
  push too. See "Root cause of the reported glitching" below.)
- `localBuffer.js` still exists and still receives every chunk — it now
  serves exactly one purpose: holding each match's very first chunk (the
  WebM/Matroska header) so a freshly (re)started ffmpeg process — a
  reconnect, an ABR hot-restart — can be primed with it. It is no longer
  read from for clip cutting.
- **Pre-roll/post-roll:** 15s / 5s (`CLIP_PRE_ROLL_SEC`/`CLIP_POST_ROLL_SEC`
  in `server.js`).
- **Duplicate prevention:** a repeat `/clip` call for the same
  matchId+eventType+timestamp (double click, client retry, even
  genuinely concurrent requests) is deduped to a single cut+upload.
- **Cloudflare failure ≠ lost clip:** if forwarding to `mainServerUrl`
  fails, the local `.mp4` is kept and retried with backoff
  (`retry-queue.local.json` persists the queue across a restart of this
  process) — never silently discarded. The local copy is only deleted
  once `server.js` confirms BOTH R2 and Drive have it.
- **Multi-match isolation:** every match's `master.mp4`/clips live under
  their own `matchId` folder; a clip request always reads only that
  match's master recording.

## Root cause of the reported glitching (YouTube glitchy/cut/frozen vs. rock-solid from vMix)

The live push and the local recorder are both fed by the SAME source:
`getDisplayMedia()` screen-capturing the `live-output.html` popup window,
software-encoded to WebM (VP8) by the browser's `MediaRecorder`, chunked
every 1s, and POSTed to this engine's `/ingest`, which pipes the raw bytes
into ffmpeg's `stdin` as one continuous container. vMix never goes near
any of that — it captures and encodes natively, on a hardware-driven
clock, with no browser, no intermediate software codec, and no HTTP hop
in between. That gap is the real ceiling on how solid this can ever be
compared to vMix (see "Known limitation" below) — but two concrete bugs
in that pipeline were making it much worse than that ceiling required,
and both are now fixed:

1. **`ingestChunk()` used to drop a chunk outright under backpressure**
   ("a skipped frame is far better than ever-growing latency"). That
   reasoning is correct for independent video frames but wrong here:
   each `buf` is a byte-slice of one continuous WebM stream, so dropping
   one splices a gap into the middle of the container ffmpeg is
   demuxing — which is exactly what a demuxer resyncing mid-Cluster
   looks like on the output side: garbled frames, a freeze, or a torn
   RTMPS connection. Fixed: every byte is now always written, in order;
   Node's own stdin buffer absorbs a brief stall losslessly, and
   sustained backpressure (measured via real `stdin.writableLength`, not
   a boolean latch) now only ever feeds the existing ABR bitrate
   step-down — never corrupts the stream. A hard ceiling
   (`MAX_STDIN_BUFFERED_BYTES`) forces a clean, already-existing
   reconnect if the pipe is genuinely stuck rather than just slow.
2. **The panel's `ondataavailable` sent each chunk with a bare,
   unawaited `fetch()` and silently swallowed any failure.** A lost (or,
   under load, out-of-order — nothing serialized delivery) chunk is the
   same container-corruption problem as #1, just introduced one hop
   earlier, before the bytes ever reach this engine. Fixed in
   `cricket-panel.html`: chunks are now sent through a strict FIFO queue
   (chunk N+1 is never even started until chunk N's POST has completed)
   with retry-with-backoff on failure, so delivery is both ordered and
   effectively lossless on the loopback connection between the two.
3. **ffmpeg was given no explicit timing discipline.** Both the live
   push and the local recorder now read their input with
   `-use_wallclock_as_timestamps 1 -fflags +genpts+igndts` (rebuilds
   clean, monotonic timestamps from real arrival time instead of
   trusting the browser's own — which can jitter under DOM/tab/GC load)
   and force `-vsync cfr` on the output (true constant frame rate,
   never variable, regardless of any remaining input irregularity).

### Known limitation (architectural, not a bug)

Even with the above, the frame source itself — a screen-captured DOM
window, software-encoded on the CPU — is not a hardware-clocked capture
the way vMix's is. Under heavy load on the operator's machine (a slow
CPU, the browser tab backgrounded/throttled, a GC pause) the *source*
video can still fall behind momentarily; the fixes above make sure that
never corrupts the stream, but they cannot manufacture frames the browser
never produced. If glitching is ever still observed after this fix, check
`/health`'s `metrics.fps`/`droppedFrames` and the browser tab's own
performance first — that distinguishes "the source fell behind" from a
pipeline bug. Closing that remaining gap fully would mean replacing the
browser capture with a native capture/compositor (outside this repo's
current architecture) — a larger, separate project.

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
