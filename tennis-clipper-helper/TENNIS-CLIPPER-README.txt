AllSportsLive TENNIS Clipper - launcher
=======================================

This is the TENNIS Clipper (TennisClipper.exe, port 5009, the
asl-tn-clipper:// link). It is a different program from the Cricket
Clipper (ClipperHelper.exe, port 5005) and the Volleyball Clipper
(VolleyballClipper.exe, port 5007) - it never starts, stops or changes
them. Keep it in its own folder, e.g. C:\AllSportsLive\TennisClipper.

1. Put these files in the folder that has TennisClipper.exe:
     tennis-clipper-launch.vbs
     install-tennis-clipper-launcher.bat
     uninstall-tennis-clipper-launcher.bat
2. Double-click install-tennis-clipper-launcher.bat (once per PC,
   no admin rights needed).
3. Open the tennis scoring panel, its Clips tab, and click
   "Start Clipper". The first time Chrome asks to open a program:
   tick "Always allow" and click Open.
4. The Setup page opens (http://localhost:5009/setup): put the folder
   vMix records to, and Save.

Every point scored becomes a clip: 7 s before the point + 3 s after it
by default (the match's own window, set on the website, wins). Clips
are cut and filed on this PC even with no internet, under
<recording folder>\TennisClips\<Tournament>\<Match>\Set-N\Game-M\,
with links in each player's folder, and uploaded once the internet is
there. Clips pressed by hand go to Set-N\Moments.

Files of its own (nothing shared with the other Clippers):
  tennis-clipper-config.json   its settings
  tennis-clip-jobs.json        its clip queue (survives a restart)
  tennis-clipper-log.txt       its log

To remove the launcher: uninstall-tennis-clipper-launcher.bat
(TennisClipper.exe, its settings and its clips stay where they are).
