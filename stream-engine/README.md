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
3. **Full-match local recording:** continuously mux the SAME bytes into a
   real, independently-playable `master.mp4` per match under
   `StreamEngineData/Recordings/<matchId>/` — see below.

All three are fed by the ONE browser capture — never a second capture,
never a second encoder, and none of them ever uses YouTube, R2, Drive, or
a raw `.webm` chunk file as anyone else's *source*: R2/Drive are upload
*destinations* only (handled entirely by the existing `server.js` at the
repo root — async, independent per-destination retry, survives a
restart), and clips are always cut from this engine's own local footage.

## Full-match local recording (independent of streaming/network)

`POST /recording-start` (same call the panel already makes for clip
recording) now also starts a **local libx264 encode of the full match to
MP4**, entirely separate from the live YouTube push:

- Lives at `StreamEngineData/Recordings/<matchId>/master.mp4` — a real,
  standalone, playable file (VLC/Windows/macOS/Android/iOS/any editor),
  never a `.webm`/`.ts`/`.m3u8`.
- Its own resolution/bitrate (`RECORDING_BITRATE_KBPS`, independent of the
  live stream's adaptive ladder) — a weak connection degrades the LIVE
  STREAM only; this keeps recording at fixed quality regardless.
- **libx264 (CPU), not NVENC** — deliberately, so it never competes with
  the live push for the GPU's limited concurrent NVENC sessions.
- Fragmented MP4 (`-movflags frag_keyframe+empty_moov+default_base_moof`)
  with a 2s keyframe interval: the file is valid and playable at any
  point while still recording, not just after a clean stop — a crash or
  kill loses at most ~2s, never the whole match. Verified by killing the
  encoder process mid-recording and confirming the file up to that point
  still plays and a NEW segment (`master_part2.mp4`, ...) picks up
  automatically without operator action.
- `GET /recording-info?matchId=...` reports the segment list, total size,
  and free disk space (`/status`'s `recorder` field has the same, plus
  live state/duration, for the panel's status card).
- This is a completely separate file/process from `localBuffer.js`'s
  short rolling buffer (deleted ~90s after Recording stops) — the master
  recording is never touched by that cleanup.

## Fixed: corrupted/garbled clips ("looks like chunks, not real video")

Clip cutting previously wrote the covering `.webm` chunks to one
intermediate file and reopened it with `-ss` *before* `-i` (an index/Cues
seek). On some encode paths — confirmed with an H.264-in-WebM
capture-card feed — concatenating independent MediaRecorder blobs like
that produces a file whose seek index isn't trustworthy, and pre-seeking
into it corrupted the output. It's now piped straight into ffmpeg's
stdin with `-ss` *after* `-i` (decode-order, no index dependency) — the
same "continuous pipe decode" mechanism already used for the live NVENC
push. `localBuffer.js` also now detects an actual missing chunk (e.g. a
dropped `/ingest` POST) in the requested window and fails the clip
loudly instead of silently stitching around the hole — see
`getClipWindow`'s gap check.

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

## Adaptive bitrate (unstable/fluctuating internet)

The panel's Live Studio card has a **Streaming Quality Mode** (Manual /
Adaptive) plus an **Automatic Resolution Fallback** checkbox. In Adaptive
mode (the default), the selected resolution is the *target*, never
silently changed — the engine reacts to the real connection in real time
by hot-restarting the encoder (stop + go-live, ~1-2s, no camera
reopen) at a new bitrate/fps/resolution:

1. Reduce bitrate one rung at a time (High → Medium → Low), fast on a
   genuinely bad signal, only after a sustained dip on a mild one.
2. If still critical at the bitrate floor, cut fps to `emergencyFps`
   (default 15) — the last lever before touching resolution.
3. Only if Automatic Resolution Fallback is checked, and only after that's
   sustained for `holdCriticalSec` (default 45s), drop one resolution tier
   (1080p → 720p → 480p). A `protectionActive` flag + message surfaces on
   `/health` once the connection genuinely can't sustain the selected
   resolution, so the panel can say so plainly instead of pretending a
   very low bitrate is still good 1080p.
4. Recovery is the mirror image, but slower and only after
   `holdStableUpSec` (default 45s) of a clean signal — bitrate/fps/
   resolution climb back up one rung at a time toward the original
   selection, never in one jump.

A short/total internet drop does **not** end the stream: an unexpected
ffmpeg exit is classified as either a network blip (connection reset,
broken pipe, timeout, …) — `state: 'reconnecting'`, unlimited retries at
capped backoff, exactly the "internet goes up and down" case this exists
for — or a fatal/config error (bad args, no NVENC, missing filter), which
keeps the original bounded auto-restart and eventually surfaces
`state: 'crashed'` for the operator to fix. Local recording/clips
(`localBuffer.js`, fed straight from `/ingest`) are completely unaffected
either way — they don't care whether the YouTube push is live, reconnecting,
or crashed.

All of the numbers above (bitrate ladder per resolution, safety factor,
hold durations, emergency fps) are runtime-configurable via
`GET`/`POST /adaptive-config` — no restart needed, and no assumption that
YouTube's own limits apply to every provider.

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
