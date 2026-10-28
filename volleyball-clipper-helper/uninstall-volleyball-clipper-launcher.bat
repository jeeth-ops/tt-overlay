@echo off
REM ============================================================
REM  AllSportsLive VOLLEYBALL Clipper - remove the launcher from this PC.
REM  Stops VolleyballClipper.exe and forgets the asl-vb-clipper:// link.
REM  The CRICKET Clipper (ClipperHelper.exe, asl-clipper://) is not touched.
REM  VolleyballClipper.exe, its settings and its clips stay where they are.
REM ============================================================
taskkill /F /T /IM VolleyballClipper.exe >nul 2>&1
reg delete "HKCU\Software\Classes\asl-vb-clipper" /f >nul 2>&1
echo.
echo  Volleyball Clipper launcher removed. You can still start VolleyballClipper.exe by double-clicking it.
echo.
pause
