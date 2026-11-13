@echo off
REM ============================================================
REM  AllSportsLive TENNIS Clipper - ONE-TIME setup on this PC.
REM  Teaches Windows the asl-tn-clipper:// link, so the tennis
REM  panel's Start / Quit Clipper buttons can run TennisClipper.exe
REM  in the background: no black window, nothing on the taskbar.
REM
REM  It NEVER touches the CRICKET Clipper (asl-clipper://,
REM  ClipperHelper.exe) or the VOLLEYBALL Clipper (asl-vb-clipper://,
REM  VolleyballClipper.exe): not their links, not their folders.
REM  Only for this Windows user - no admin rights needed.
REM  Keep this folder where it is (or run this again after moving it).
REM ============================================================
cd /d "%~dp0"
if exist "%~dp0ClipperHelper.exe" goto otherfolder
if exist "%~dp0clipper-launch.vbs" goto otherfolder
if exist "%~dp0VolleyballClipper.exe" goto otherfolder
if exist "%~dp0volleyball-clipper-launch.vbs" goto otherfolder
if not exist "%~dp0TennisClipper.exe" goto noexe
if not exist "%~dp0tennis-clipper-launch.vbs" goto novbs

reg add "HKCU\Software\Classes\asl-tn-clipper" /ve /d "URL:AllSportsLive Tennis Clipper" /f >nul || goto regfail
reg add "HKCU\Software\Classes\asl-tn-clipper" /v "URL Protocol" /d "" /f >nul || goto regfail
reg add "HKCU\Software\Classes\asl-tn-clipper\DefaultIcon" /ve /d "\"%~dp0TennisClipper.exe\",0" /f >nul || goto regfail
reg add "HKCU\Software\Classes\asl-tn-clipper\shell\open\command" /ve /d "\"%SystemRoot%\System32\wscript.exe\" \"%~dp0tennis-clipper-launch.vbs\" \"%%1\"" /f >nul || goto regfail

echo.
echo  ==========================================================
echo   DONE - Tennis Clipper launcher installed on this PC.
echo   (The Cricket and Volleyball Clippers are not changed.)
echo.
echo   Now open the TENNIS scoring panel, open its Clips tab,
echo   then "Start Clipper". The first time, Chrome asks to
echo   open a program: tick "Always allow" and click Open.
echo  ==========================================================
echo.
pause
exit /b 0

:otherfolder
echo.
echo  This folder has ANOTHER sport's Clipper (the Cricket Clipper's
echo  ClipperHelper.exe / clipper-launch.vbs, or the Volleyball
echo  Clipper's VolleyballClipper.exe / volleyball-clipper-launch.vbs):
echo    %~dp0
echo  Nothing was changed. Put the Tennis Clipper in its OWN folder
echo  (TennisClipper.exe + these launcher files), then run this again.
echo.
pause
exit /b 1

:noexe
echo.
echo  TennisClipper.exe is not in this folder:
echo    %~dp0
echo  Build it here first (npm install, then npm run build), or copy
echo  these launcher files into the folder that has TennisClipper.exe.
echo.
pause
exit /b 1

:novbs
echo.
echo  tennis-clipper-launch.vbs is missing from this folder - unzip all the launcher files here.
echo.
pause
exit /b 1

:regfail
echo.
echo  Windows did not accept the setup. Try again, or right-click and Run as administrator.
echo.
pause
exit /b 1
