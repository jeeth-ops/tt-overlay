# Bundled ffmpeg / ffprobe

This folder is where the Stream Engine looks for its **own copy** of
`ffmpeg.exe` and `ffprobe.exe` — if both are present here, the operator
never needs to install ffmpeg system-wide or set `FFMPEG_PATH`/
`FFPROBE_PATH` at all. `server.js`'s `resolveFfmpegPath()`/
`resolveFfprobePath()` check here FIRST, before any env var or system
PATH — see their own comments.

**These binaries are NOT committed to this repository** (multi-hundred-MB
executables don't belong in git — see `.gitignore`). You place them here
once per machine, or a packaging/installer step does it as part of
building a distributable Stream Engine package.

## What to download

Get the **"full" Windows build** from
https://www.gyan.dev/ffmpeg/builds/ (the `ffmpeg-git-full.7z` or a
dated `ffmpeg-<version>-full_build.7z` release) — NOT the "essentials"
build. The full build is the one that ships `h264_nvenc` (NVIDIA NVENC).
The `@ffmpeg-installer/ffmpeg` npm package used elsewhere in this repo
for clip cutting is a **minimal build without hardware encoders** and
will NOT work here.

From the downloaded archive's `bin/` folder, copy exactly these two
files into THIS folder (`stream-engine/bin/`):

```
stream-engine/
  bin/
    ffmpeg.exe
    ffprobe.exe
```

(`ffplay.exe`, if present in the archive, isn't needed here.)

## Verifying it's actually being used

Start the Stream Engine and check the startup log — it prints which
ffmpeg it resolved and where from:

```
ffmpeg: C:\...\stream-engine\bin\ffmpeg.exe (bundled)
```

If it instead says `(FFMPEG_PATH env var)` or `(system PATH)`, the
bundled binaries above weren't found at the expected path/filenames —
double check `stream-engine/bin/ffmpeg.exe` and `ffprobe.exe` exist
exactly there.

`GET /status` also reports `ffmpegSource`/`ffprobeSource` for the same
check from the Cricket Panel side, plus `nvencAvailable`/`nvencDetail`
so you can confirm hardware encoding is actually working before match
day (see the main `stream-engine/README.md`'s "Verifying NVENC before
match day" section).

## macOS

Same idea, filenames without `.exe` (`ffmpeg`, `ffprobe`); `VideoToolbox`
is macOS's hardware encoder rather than NVENC — this project's own
NVENC-specific checks currently assume Windows (`NATIVE_CAPTURE_SUPPORTED`
in `server.js`), so macOS support beyond ffmpeg path resolution itself
isn't implemented yet.
