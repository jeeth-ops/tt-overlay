# AllSportsLive Stream Engine (local, Part 2)

A small local service that runs **on the operator's own PC**, next to the
Cricket Panel browser tab. It takes the camera+overlay video the panel is
already capturing in the browser, encodes it with the GPU (NVIDIA NVENC),
and pushes it to YouTube over RTMPS.

It never runs on Render. No 1080p video ever touches `server.js`, Mongo,
or Socket.IO — see `../PART2_REPORT.md` for the exact data/video flow.

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
| GET | `/status` | ffmpeg/NVENC/stream-key/encoder readiness |
| POST | `/set-stream-key` | `{streamKey}` — stored locally only, never echoed back |
| POST | `/go-live` | `{resolution, fps, bitrateKbps}` — starts the NVENC→RTMPS push |
| POST | `/ingest` | raw webm bytes from the panel's MediaRecorder |
| POST | `/stop` | gracefully ends the stream |
| GET | `/health` | live bitrate/fps/dropped-frames/duration/state |

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
