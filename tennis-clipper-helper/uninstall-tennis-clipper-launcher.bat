@echo off
REM ============================================================
REM  AllSportsLive TENNIS Clipper - remove the launcher from this PC.
REM  Stops TennisClipper.exe and forgets the asl-tn-clipper:// link.
REM  The CRICKET Clipper (ClipperHelper.exe, asl-clipper://) and the
REM  VOLLEYBALL Clipper (VolleyballClipper.exe, asl-vb-clipper://) are
REM  not touched. TennisClipper.exe, its settings and its clips stay.
REM ============================================================
taskkill /F /T /IM TennisClipper.exe >nul 2>&1
reg delete "HKCU\Software\Classes\asl-tn-clipper" /f >nul 2>&1
echo.
echo  Tennis Clipper launcher removed. You can still start TennisClipper.exe by double-clicking it.
echo.
pause
