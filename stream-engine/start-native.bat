@echo off
REM ================================================================
REM  AllSportsLive Stream Engine - NATIVE PROGRAM FEED launcher
REM
REM  Double-click this file to start. Nothing else needs to be run:
REM  ClipperHelper.exe is NOT required. The clip organiser is only a
REM  code file that this engine reads from the clipper-helper folder
REM  sitting NEXT TO this one.
REM
REM  Expected folder layout:
REM      <your folder>\stream-engine\     <- this file, ffmpeg.exe
REM      <your folder>\clipper-helper\    <- clipOrganizer.js
REM ================================================================
cd /d "%~dp0"

if not exist "%~dp0ffmpeg.exe" (
    echo.
    echo  WARNING: ffmpeg.exe was not found in this folder:
    echo    %~dp0ffmpeg.exe
    echo  Put ffmpeg.exe here, or edit the FFMPEG_PATH line below.
    echo.
    pause
)

set FFMPEG_PATH=%~dp0ffmpeg.exe
set NATIVE_PROGRAM_FEED=true


REM ================================================================
REM  CAMERA RESOLUTION  - the one setting worth getting right
REM ================================================================
REM  This machine reports "GPU scale not available", so EVERY resize
REM  runs on the CPU. The cheapest possible setup is therefore to open
REM  the camera at exactly the resolution you stream at - then there is
REM  no resize anywhere in the chain, and the whole frame budget goes
REM  to the encoder instead.
REM
REM  So: keep this line and Live Studio's Resolution the SAME.
REM
REM  720p is the recommended starting point. It is already far better
REM  than the 640x480 this card was being opened at before, it halves
REM  the USB bandwidth of 1080p, and it leaves the most headroom.

set STREAM_ENGINE_CAMERA_MODE=1280x720@30

REM  --- Want to try 1080p? ---
REM  Put a REM in front of the 720p line above, remove the REM below,
REM  AND set Live Studio -> Resolution to 1080p (they must match).
REM  Test for 10 minutes before a real match: watch for
REM  "real-time buffer too full" or repeated "[relay] live fell behind"
REM  in this window. If you see either, go back to 720p.
REM
REM set STREAM_ENGINE_CAMERA_MODE=1920x1080@30
REM
REM  --- Camera not opening at all? ---
REM  Put a REM in front of every CAMERA_MODE line so the engine picks
REM  the mode itself, then read the "camera offers ... mode(s)" line it
REM  prints and choose one of those.


REM ================================================================
REM  OPTIONAL - only touch these if you have a reason
REM ================================================================

REM  Where recordings and clips are written. Default is right next to
REM  this folder. If stream-engine lives somewhere OneDrive or a backup
REM  tool syncs (Downloads is a common one), that sync can lock the
REM  recording file mid-match and break it. Point this at a plain
REM  folder outside any sync to be safe:
REM set STREAM_ENGINE_DATA_ROOT=C:\StreamEngineRecordings

REM  Program Monitor smoothness in the panel. Lower these if the panel
REM  preview is costing you frames; they never affect the stream or the
REM  recording. Defaults: 15 and 960.
REM set STREAM_ENGINE_PREVIEW_FPS=15
REM set STREAM_ENGINE_PREVIEW_WIDTH=960

REM  How much captured-but-not-yet-encoded video ffmpeg may hold. This
REM  is a LATENCY allowance, not a safety net - too big and the stream
REM  runs seconds behind reality. Default 64M. Raise only if you see
REM  dropped frames on a machine you know is otherwise keeping up.
REM set STREAM_ENGINE_CAMERA_RTBUFSIZE=64M

REM  Ceiling for raw camera modes, in MB/s. Default 150 allows 1080p30
REM  and 720p60 while still excluding 1080p60 raw, which overran the
REM  buffer on this card. Set 40 to restore the old conservative
REM  behaviour.
REM set STREAM_ENGINE_RAW_CAP_MBPS=150


echo.
echo  Starting AllSportsLive Stream Engine - NATIVE PROGRAM FEED
echo  ---------------------------------------------------------
echo   ffmpeg      : %FFMPEG_PATH%
echo   Camera mode : %STREAM_ENGINE_CAMERA_MODE%
if defined STREAM_ENGINE_DATA_ROOT echo   Recordings  : %STREAM_ENGINE_DATA_ROOT%\StreamEngineData
echo.
echo  Set Live Studio -^> Resolution to match the camera mode above.
echo.
echo  Watch this window for:
echo    "clip organiser loaded"        - player/team clip folders are on
echo    "camera mode auto-detected"    - what the camera actually opened at
echo    "[CLIP FILED]"                 - a clip was filed into its folders
echo.

REM Run node directly (not through npm): Ctrl+C then reaches the Stream
REM Engine's own clean shutdown without npm's extra process and its
REM error spam.
node server.js

echo.
echo Stream Engine stopped. Press any key to close this window.
pause >nul
