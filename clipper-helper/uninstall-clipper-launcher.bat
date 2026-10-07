@echo off
REM ============================================================
REM  AllSportsLive Clipper - remove the launcher from this PC.
REM  Stops a background Clipper and forgets the asl-clipper:// link.
REM  ClipperHelper.exe, your settings and your clips are not touched.
REM ============================================================
taskkill /F /T /IM ClipperHelper.exe >nul 2>&1
reg delete "HKCU\Software\Classes\asl-clipper" /f >nul 2>&1
echo.
echo  Clipper launcher removed. You can still start ClipperHelper.exe by double-clicking it.
echo.
pause
