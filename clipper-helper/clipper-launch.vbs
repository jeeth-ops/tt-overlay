' ============================================================
'  AllSportsLive Clipper launcher
'  Starts ClipperHelper.exe with NO window (nothing on the taskbar
'  either), or stops it. The panel's Start / Stop Clipper buttons
'  call this through the asl-clipper:// link that
'  install-clipper-launcher.bat registers (one time, per PC).
'  Everything the helper prints goes to clipper-log.txt here.
' ============================================================
Option Explicit
Dim sh, fso, dir, action, exe, logFile, oldLog
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\ClipperHelper.exe"
logFile = dir & "\clipper-log.txt"
oldLog = dir & "\clipper-log-old.txt"

action = "start"
If WScript.Arguments.Count > 0 Then
  If InStr(LCase(WScript.Arguments(0)), "stop") > 0 Then action = "stop"
End If

Function IsRunning()
  Dim wmi, procs
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'ClipperHelper.exe'")
  IsRunning = (procs.Count > 0)
End Function

If action = "stop" Then
  ' /T also ends the ffmpeg it started. Clips already cut stay saved and
  ' unfinished ones carry on the next time the Clipper starts.
  sh.Run "taskkill /F /T /IM ClipperHelper.exe", 0, True
  WScript.Quit 0
End If

' Already running: nothing to do (the panel just opens its tab).
If IsRunning() Then WScript.Quit 0

If Not fso.FileExists(exe) Then
  MsgBox "ClipperHelper.exe is not in this folder:" & vbCrLf & dir & vbCrLf & vbCrLf & _
    "Put the launcher files next to ClipperHelper.exe and run install-clipper-launcher.bat again.", _
    vbExclamation, "AllSportsLive Clipper"
  WScript.Quit 1
End If

' Keep the log small: past 5 MB it becomes clipper-log-old.txt.
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 5242880 Then
    If fso.FileExists(oldLog) Then fso.DeleteFile oldLog, True
    fso.MoveFile logFile, oldLog
  End If
End If

sh.CurrentDirectory = dir
' The panel opens the Clipper tab itself - no extra browser window from the helper.
sh.Environment("PROCESS")("CLIPPER_NO_BROWSER") = "1"
' Window style 0 = hidden: no window, nothing on the taskbar.
sh.Run "cmd /c """"" & exe & """ >> """ & logFile & """ 2>&1""", 0, False
