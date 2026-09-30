@echo off
REM ================================================================
REM AllSportsLive Stream Engine - NATIVE PROGRAM FEED launcher.
REM
REM Same as start.bat, but also sets NATIVE_PROGRAM_FEED=true - the
REM camera+overlay compositor pipeline (no gdigrab), where ffmpeg opens
REM the camera / capture card directly.
REM
REM FFMPEG_PATH is computed from %~dp0 (the folder this .bat is in), so
REM it keeps working if this whole folder is moved, renamed or copied to
REM another PC. Never type a path by hand.
REM ================================================================
cd /d "%~dp0"

if not exist "%~dp0ffmpeg.exe" (
    echo.
    echo  WARNING: ffmpeg.exe was not found in this folder:
    echo    %~dp0ffmpeg.exe
    echo  Put ffmpeg.exe here, or edit this file's FFMPEG_PATH line to
    echo  point at wherever it actually is.
    echo.
    pause
)

set FFMPEG_PATH=%~dp0ffmpeg.exe
set NATIVE_PROGRAM_FEED=true

REM ----------------------------------------------------------------
REM CAMERA MODE - leave this OFF unless you have a reason.
REM
REM Off (the default), the engine asks the camera what it supports and
REM picks the best real mode itself. That is what you want, and it is
REM the only thing that works when the source changes - a capture card
REM publishes whatever its HDMI input is currently sending, so the right
REM mode is not the same on every ground or with every camera.
REM
REM Forcing a mode the device does NOT support does not fall back - the
REM device refuses it, ffmpeg cannot open the input at all, and you get
REM no picture:
REM
REM     [in#0] Could not set video options
REM     Error opening input file video=AVMATRIX USB Capture Video.
REM     ffmpeg exited unexpectedly after 0s
REM
REM A laptop webcam hides this, because 1280x720@30 is a mode almost
REM every webcam has. A capture card is where it bites.
REM
REM Only set this if the "camera offers ..." line in this window shows
REM the mode you want AND auto-detect is picking a smaller one. Use a
REM mode from that list exactly as it is printed.
REM
REM set STREAM_ENGINE_CAMERA_MODE=1920x1080@30
REM ----------------------------------------------------------------

REM ----------------------------------------------------------------
REM SOURCE PROBE - when the program feed starts, the engine first opens
REM the camera for ~4 seconds and MEASURES what it really delivers (real
REM frame rate, repeated frames, interlace, timestamps) and builds the
REM camera chain from that. Look for "measuring what ... really delivers"
REM in this window. To compare the laptop camera with the AVMATRIX by hand
REM (with the engine stopped):
REM     node sourceProbe.js --compare "<laptop camera>" "AVMATRIX USB Capture Video" --program-fps 50
REM Skip the automatic probe with:
REM set STREAM_ENGINE_SOURCE_PROBE=0
REM ----------------------------------------------------------------

REM ----------------------------------------------------------------
REM WHERE RECORDINGS AND CLIPS ARE SAVED - by default right next to this
REM folder (stream-engine\StreamEngineData\Recordings\...). If this
REM folder sits somewhere OneDrive or a backup tool syncs (Downloads is
REM the common one), that sync can lock the recording file while it is
REM being written and the recording fails mid-match. To store them on a
REM plain folder instead, uncomment the next line.
REM
REM set STREAM_ENGINE_DATA_ROOT=C:\StreamEngineRecordings
REM ----------------------------------------------------------------

echo.
echo  Starting AllSportsLive Stream Engine - NATIVE PROGRAM FEED
echo  ---------------------------------------------------------
echo   ffmpeg      : %FFMPEG_PATH%
if defined STREAM_ENGINE_CAMERA_MODE (
    echo   Camera mode : %STREAM_ENGINE_CAMERA_MODE%  ^(FORCED^)
    echo                 Set Live Studio -^> Resolution to match this.
) else (
    echo   Camera mode : auto-detect ^(recommended^)
)
if defined STREAM_ENGINE_DATA_ROOT echo   Recordings  : %STREAM_ENGINE_DATA_ROOT%\StreamEngineData
echo.
echo  Watch this window for:
echo    "camera offers ..."          - every mode the card really supports
echo    "camera mode auto-detected"  - the one it chose
echo    "clip organiser loaded"      - player/team clip folders are on
echo    "[CLIP FILED]"               - a clip was filed into its folders
echo.

REM Run node directly (not through npm): Ctrl+C then reaches the Stream
REM Engine's own clean shutdown without npm's extra process and its
REM error spam.
node server.js

echo.
echo Stream Engine stopped. Press any key to close this window.
pause >nul
