@echo off
REM ============================================================
REM  AllSportsLive Clipper - ONE-TIME setup on this PC.
REM  Teaches Windows the asl-clipper:// link, so the panel's
REM  Start / Stop Clipper buttons can run ClipperHelper.exe in the
REM  background: no black window, nothing on the taskbar.
REM  Only for this Windows user - no admin rights needed.
REM  Keep this folder where it is (or run this again after moving it).
REM ============================================================
cd /d "%~dp0"
if not exist "%~dp0ClipperHelper.exe" goto noexe
if not exist "%~dp0clipper-launch.vbs" goto novbs

reg add "HKCU\Software\Classes\asl-clipper" /ve /d "URL:AllSportsLive Clipper" /f >nul || goto regfail
reg add "HKCU\Software\Classes\asl-clipper" /v "URL Protocol" /d "" /f >nul || goto regfail
reg add "HKCU\Software\Classes\asl-clipper\DefaultIcon" /ve /d "\"%~dp0ClipperHelper.exe\",0" /f >nul || goto regfail
reg add "HKCU\Software\Classes\asl-clipper\shell\open\command" /ve /d "\"%SystemRoot%\System32\wscript.exe\" \"%~dp0clipper-launch.vbs\" \"%%1\"" /f >nul || goto regfail

echo.
echo  ==========================================================
echo   DONE - Clipper launcher installed on this PC.
echo.
echo   Now open the scoring panel and click  "Start Clipper".
echo   The first time, Chrome asks to open a program:
echo   tick "Always allow" and click Open. That's all.
echo  ==========================================================
echo.
pause
exit /b 0

:noexe
echo.
echo  ClipperHelper.exe is not in this folder:
echo    %~dp0
echo  Copy these launcher files into the SAME folder as ClipperHelper.exe,
echo  then double-click install-clipper-launcher.bat again.
echo.
pause
exit /b 1

:novbs
echo.
echo  clipper-launch.vbs is missing from this folder - unzip all the launcher files here.
echo.
pause
exit /b 1

:regfail
echo.
echo  Windows did not accept the setup. Try again, or right-click and Run as administrator.
echo.
pause
exit /b 1
