ALLSPORTSLIVE VOLLEYBALL CLIPPER - kaise use karein
==================================================

Ye VOLLEYBALL ka Clipper hai: VolleyballClipper.exe.
Cricket ka Clipper (ClipperHelper.exe) ek ALAG program hai - dono
ek doosre ko kabhi start / stop / change nahi karte.

  Cricket:    ClipperHelper.exe      port 5005   asl-clipper://
  Volleyball: VolleyballClipper.exe  port 5007   asl-vb-clipper://

ZAROORI: Volleyball Clipper ko apne ALAG folder me rakho
(jaise C:\AllSportsLive\VolleyballClipper). Cricket wale folder me
volleyball ki koi file mat daalo, aur cricket folder me ye BAT mat chalao.

EK BAAR (har laptop pe sirf pehli baar):
 1. Is folder me VolleyballClipper.exe banao (npm install, phir
    npm run build) - aur ffmpeg.exe bhi isi folder me rakho
    (cricket Clipper folder wala ffmpeg.exe copy kar sakte ho).
 2. Ye launcher files isi folder me daalo.
 3. install-volleyball-clipper-launcher.bat pe double-click karo.
    "DONE" likha aaye to window band kar do.

HAR MATCH:
 1. vMix me Record start karo (MP4).
 2. Volleyball panel me Clipper chip -> "Start Clipper".
 3. Pehli baar Chrome poochega program kholna hai kya:
    "Always allow" tick karo aur Open dabao.
 4. Pehli baar Setup tab me vMix ka recording FOLDER daalo -> Save.
 5. Har point = 10 sec ka clip (point se 7 sec pehle + 3 sec baad).
    Point dabate hi clip ban jaata hai; scoring kabhi nahi rukti.
 6. Match ke baad panel me Stop. Program band karna ho to Clipper ke
    "First time on this PC..." hisse me "Quit the Volleyball Clipper
    on this PC" (cricket ka Clipper band nahi hota).

KUCH GADBAD HO TO:
 - volleyball-clipper-log.txt kholo (isi folder me).
 - Folder badla? install-volleyball-clipper-launcher.bat dobara chalao.
 - Hatana ho to uninstall-volleyball-clipper-launcher.bat chalao
   (cricket ka Clipper isse nahi hatta).
