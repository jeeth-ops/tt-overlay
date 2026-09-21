@echo off
REM ================================================================
REM AllSportsLive Stream Engine — NATIVE PROGRAM FEED launcher.
REM
REM Same as start.bat, but also sets NATIVE_PROGRAM_FEED=true — the
REM opt-in camera+overlay compositor pipeline (no gdigrab) documented in
REM README.md. This is UNVERIFIED on real hardware — if something looks
REM wrong, close this window and use the normal start.bat instead (the
REM old gdigrab path is unaffected by anything here).
REM
REM Double-click this file to start the Stream Engine in native mode. It
REM automatically points FFMPEG_PATH at the ffmpeg.exe sitting in this
REM SAME folder (using %~dp0) — no need to type "set FFMPEG_PATH=..." by
REM hand, and it keeps working even if this whole stream-engine folder
REM is moved/renamed/copied to a different PC.
REM ================================================================
cd /d "%~dp0"

if not exist "%~dp0ffmpeg.exe" (
    echo.
    echo  WARNING: ffmpeg.exe was not found in this folder:
    echo    %~dp0ffmpeg.exe
    echo  Put ffmpeg.exe here, or edit this start-native.bat's FFMPEG_PATH line
    echo  to point at wherever it actually is.
    echo.
    pause
)

set FFMPEG_PATH=%~dp0ffmpeg.exe
set NATIVE_PROGRAM_FEED=true

echo Starting AllSportsLive Stream Engine — NATIVE PROGRAM FEED mode...
echo ffmpeg: %FFMPEG_PATH%
echo NATIVE_PROGRAM_FEED: %NATIVE_PROGRAM_FEED%
echo.

call npm start

REM Keeps the window open after Stream Engine stops/crashes, so any
REM error message is actually readable instead of the window vanishing.
echo.
echo Stream Engine stopped. Press any key to close this window.
pause >nul
