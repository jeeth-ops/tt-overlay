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

REM 📁 WHERE RECORDINGS/CLIPS ARE SAVED — by default, right next to this
REM folder (stream-engine\StreamEngineData\Recordings\...). If
REM stream-engine sits inside a folder Windows/OneDrive backs up or syncs
REM (Downloads is a common one), that sync can intermittently lock the
REM recording file while it's being actively written, causing "Error
REM opening output file" mid-match. To save recordings/clips somewhere
REM else instead (a plain folder on C:\, or a separate drive — anywhere
REM OneDrive/backup software doesn't touch), uncomment the next line and
REM set it to that folder (it will create a StreamEngineData subfolder
REM there):
REM set STREAM_ENGINE_DATA_ROOT=C:\StreamEngineRecordings

echo Starting AllSportsLive Stream Engine — NATIVE PROGRAM FEED mode...
echo ffmpeg: %FFMPEG_PATH%
echo NATIVE_PROGRAM_FEED: %NATIVE_PROGRAM_FEED%
if defined STREAM_ENGINE_DATA_ROOT echo Recordings/Clips folder: %STREAM_ENGINE_DATA_ROOT%\StreamEngineData
echo.

REM Run node directly (not through npm): Ctrl+C then reaches the Stream Engine's
REM own clean shutdown without npm's extra process and its error spam.
node server.js

REM Keeps the window open after Stream Engine stops/crashes, so any
REM error message is actually readable instead of the window vanishing.
echo.
echo Stream Engine stopped. Press any key to close this window.
pause >nul
