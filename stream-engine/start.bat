@echo off
REM ================================================================
REM AllSportsLive Stream Engine — one-click launcher.
REM
REM Double-click this file to start the Stream Engine. It automatically
REM points FFMPEG_PATH at the ffmpeg.exe sitting in this SAME folder
REM (using %~dp0, the folder this .bat file itself is in) — no need to
REM type "set FFMPEG_PATH=..." by hand every time, and it keeps working
REM even if this whole stream-engine folder is moved/renamed/copied to
REM a different PC, since the path is always computed relative to
REM wherever this file actually is.
REM ================================================================
cd /d "%~dp0"

if not exist "%~dp0ffmpeg.exe" (
    echo.
    echo  WARNING: ffmpeg.exe was not found in this folder:
    echo    %~dp0ffmpeg.exe
    echo  Put ffmpeg.exe here, or edit this start.bat's FFMPEG_PATH line
    echo  to point at wherever it actually is.
    echo.
    pause
)

set FFMPEG_PATH=%~dp0ffmpeg.exe

echo Starting AllSportsLive Stream Engine...
echo ffmpeg: %FFMPEG_PATH%
echo.

call npm start

REM Keeps the window open after Stream Engine stops/crashes, so any
REM error message is actually readable instead of the window vanishing.
echo.
echo Stream Engine stopped. Press any key to close this window.
pause >nul
