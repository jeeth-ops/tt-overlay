@echo off
REM ============================================================
REM  AllSportsLive VOLLEYBALL Clipper - ONE-TIME setup on this PC.
REM  Teaches Windows the asl-vb-clipper:// link, so the volleyball
REM  panel's Start / Quit Clipper buttons can run VolleyballClipper.exe
REM  in the background: no black window, nothing on the taskbar.
REM
REM  It NEVER touches the CRICKET Clipper: not its asl-clipper:// link,
REM  not its folder, not ClipperHelper.exe.
REM  Only for this Windows user - no admin rights needed.
REM  Keep this folder where it is (or run this again after moving it).
REM ============================================================
cd /d "%~dp0"
if exist "%~dp0ClipperHelper.exe" goto cricketfolder
if exist "%~dp0clipper-launch.vbs" goto cricketfolder
if not exist "%~dp0VolleyballClipper.exe" goto noexe
if not exist "%~dp0volleyball-clipper-launch.vbs" goto novbs

reg add "HKCU\Software\Classes\asl-vb-clipper" /ve /d "URL:AllSportsLive Volleyball Clipper" /f >nul || goto regfail
reg add "HKCU\Software\Classes\asl-vb-clipper" /v "URL Protocol" /d "" /f >nul || goto regfail
reg add "HKCU\Software\Classes\asl-vb-clipper\DefaultIcon" /ve /d "\"%~dp0VolleyballClipper.exe\",0" /f >nul || goto regfail
reg add "HKCU\Software\Classes\asl-vb-clipper\shell\open\command" /ve /d "\"%SystemRoot%\System32\wscript.exe\" \"%~dp0volleyball-clipper-launch.vbs\" \"%%1\"" /f >nul || goto regfail

echo.
echo  ==========================================================
echo   DONE - Volleyball Clipper launcher installed on this PC.
echo   (The Cricket Clipper is not changed in any way.)
echo.
echo   Now open the VOLLEYBALL scoring panel, click the Clipper
echo   chip, then "Start Clipper". The first time, Chrome asks to
echo   open a program: tick "Always allow" and click Open.
echo  ==========================================================
echo.
pause
exit /b 0

:cricketfolder
echo.
echo  This is the CRICKET Clipper's folder (ClipperHelper.exe or
echo  clipper-launch.vbs is here):
echo    %~dp0
echo  Nothing was changed. Put the Volleyball Clipper in its OWN folder
echo  (VolleyballClipper.exe + these launcher files), then run this again.
echo.
pause
exit /b 1

:noexe
echo.
echo  VolleyballClipper.exe is not in this folder:
echo    %~dp0
echo  Build it here first (npm install, then npm run build), or copy
echo  these launcher files into the folder that has VolleyballClipper.exe.
echo.
pause
exit /b 1

:novbs
echo.
echo  volleyball-clipper-launch.vbs is missing from this folder - unzip all the launcher files here.
echo.
pause
exit /b 1

:regfail
echo.
echo  Windows did not accept the setup. Try again, or right-click and Run as administrator.
echo.
pause
exit /b 1
