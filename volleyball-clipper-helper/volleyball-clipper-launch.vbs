' ============================================================
'  AllSportsLive VOLLEYBALL Clipper launcher
'  Starts VolleyballClipper.exe with NO window (nothing on the
'  taskbar either), or stops it. The volleyball panel's Start /
'  Quit buttons call this through the asl-vb-clipper:// link that
'  install-volleyball-clipper-launcher.bat registers (once per PC).
'
'  Only the Volleyball Clipper: it never starts, stops or looks at
'  ClipperHelper.exe (the CRICKET Clipper, asl-clipper://), vMix,
'  or any other program. Its log is volleyball-clipper-log.txt here.
' ============================================================
Option Explicit
Dim sh, fso, dir, action, exe, logFile, oldLog, port
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\VolleyballClipper.exe"
logFile = dir & "\volleyball-clipper-log.txt"
oldLog = dir & "\volleyball-clipper-log-old.txt"

action = "start"
If WScript.Arguments.Count > 0 Then
  If InStr(LCase(WScript.Arguments(0)), "stop") > 0 Then action = "stop"
End If

' The port it listens on (volleyball-clipper-config.json, default 5007).
port = "5007"
On Error Resume Next
If fso.FileExists(dir & "\volleyball-clipper-config.json") Then
  Dim cfg, re, m
  cfg = fso.OpenTextFile(dir & "\volleyball-clipper-config.json", 1).ReadAll()
  Set re = New RegExp
  re.Pattern = """port""\s*:\s*(\d+)"
  Set m = re.Execute(cfg)
  If m.Count > 0 Then port = m(0).SubMatches(0)
End If
On Error GoTo 0

Function IsRunning()
  Dim wmi, procs
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'VolleyballClipper.exe'")
  IsRunning = (procs.Count > 0)
End Function

If action = "stop" Then
  ' First ask it to close itself (it saves its queue and ends only the
  ' ffmpeg it started) ...
  On Error Resume Next
  Dim http
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 2000, 2000, 2000, 3000
  http.Open "POST", "http://127.0.0.1:" & port & "/quit", False
  http.setRequestHeader "Content-Type", "application/json"
  http.Send "{}"
  On Error GoTo 0
  Dim i
  For i = 1 To 10
    If Not IsRunning() Then WScript.Quit 0
    WScript.Sleep 300
  Next
  ' ... and if it did not, end it: only VolleyballClipper.exe and (/T) the
  ' ffmpeg IT started. ClipperHelper.exe (cricket) and vMix are untouched.
  sh.Run "taskkill /F /T /IM VolleyballClipper.exe", 0, True
  WScript.Quit 0
End If

' Already running: nothing to do (the panel just carries on).
If IsRunning() Then WScript.Quit 0

If Not fso.FileExists(exe) Then
  MsgBox "VolleyballClipper.exe is not in this folder:" & vbCrLf & dir & vbCrLf & vbCrLf & _
    "Put the Volleyball Clipper launcher files next to VolleyballClipper.exe and run install-volleyball-clipper-launcher.bat again.", _
    vbExclamation, "AllSportsLive Volleyball Clipper"
  WScript.Quit 1
End If

' Keep the log small: past 5 MB it becomes volleyball-clipper-log-old.txt.
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 5242880 Then
    If fso.FileExists(oldLog) Then fso.DeleteFile oldLog, True
    fso.MoveFile logFile, oldLog
  End If
End If

sh.CurrentDirectory = dir
' The panel opens the Setup tab itself - no extra browser window from here.
sh.Environment("PROCESS")("CLIPPER_NO_BROWSER") = "1"
' Window style 0 = hidden: no window, nothing on the taskbar.
sh.Run "cmd /c """"" & exe & """ >> """ & logFile & """ 2>&1""", 0, False
