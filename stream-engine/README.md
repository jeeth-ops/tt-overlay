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
| POST | `/ingest?matchId=&index=` | raw webm bytes from the panel's MediaRecorder — fed to the local clip buffer AND (if live) the encoder |
| POST | `/stop` | gracefully ends the YouTube stream (encoder only) |
| GET | `/health` | live bitrate/fps/dropped-frames/duration/state + clip engine state |
| POST | `/recording-start` | `{matchId, tournamentId, mainServerUrl}` — starts the local clip buffer for a match |
| POST | `/recording-stop` | `{matchId}` — stops it (buffer is kept ~90s for in-flight clips, then deleted) |
| POST | `/clip` | `{eventType, timestamp, matchId, ballMeta}` — cuts a clip from the local buffer, forwards it to `mainServerUrl`'s `/api/clips/ingest` |
| POST | `/set-folder` | legacy no-op — kept so older UI calls don't break; Drive/R2 folder routing is handled entirely by server.js now |

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
