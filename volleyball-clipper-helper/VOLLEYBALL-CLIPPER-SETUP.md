# 🏐 Volleyball Clipper v1.0 — Setup (one-time, vMix wale PC pe)

Ye **sirf VOLLEYBALL** ka Clipper hai — ek alag program. Cricket ka Clipper
(`clipper-helper/`, `ClipperHelper.exe`) isse bilkul alag hai: dono ka
program, port, Start/Stop link, settings, clip queue, clips folder aur log
alag hain, isliye volleyball install / build / start / stop karne se cricket
par koi asar nahi padta (aur ulta bhi nahi).

|                    | 🏏 Cricket Clipper            | 🏐 Volleyball Clipper (ye)              |
| ------------------ | ----------------------------- | --------------------------------------- |
| Program            | `ClipperHelper.exe`           | `VolleyballClipper.exe`                 |
| Port               | `localhost:5005`              | `localhost:5007`                        |
| Start/Stop link    | `asl-clipper://`              | `asl-vb-clipper://`                     |
| Launcher           | `clipper-launch.vbs`          | `volleyball-clipper-launch.vbs`         |
| Install BAT        | `install-clipper-launcher.bat`| `install-volleyball-clipper-launcher.bat` |
| Settings           | `config.json`                 | `volleyball-clipper-config.json`        |
| Clip queue         | `clip-jobs.json`              | `volleyball-clip-jobs.json`             |
| Clips folder       | `<recording>\Clips`           | `<recording>\VolleyballClips`           |
| Log                | `clipper-log.txt`             | `volleyball-clipper-log.txt`            |
| Stop kya band karta hai | sirf `ClipperHelper.exe` (+ uska ffmpeg) | sirf `VolleyballClipper.exe` (+ uska ffmpeg) |

> ⚠️ Volleyball Clipper ko **apne alag folder** me rakho (jaise
> `C:\AllSportsLive\VolleyballClipper`). Cricket wale Clipper folder me
> volleyball ki files mat daalo. Volleyball ka install BAT ya `npm run build`
> cricket folder me chalaoge to wo khud mana kar denge (kuch nahi badlega).

## Ek baar (har PC pe)

1. Is folder (`volleyball-clipper-helper/`) ki saari files ek **naye folder**
   me rakho.
2. Us folder me Command Prompt kholo:
   ```
   npm install
   npm run build
   ```
   → `VolleyballClipper.exe` ban jayega (cricket ke `ClipperHelper.exe` ko
   chhuta bhi nahi). `pkg` chahiye (`npm i -g pkg`) — wahi jo cricket ke
   build me lagta hai.
3. `ffmpeg.exe` isi folder me rakho (cricket Clipper folder wala `ffmpeg.exe`
   copy kar sakte ho — copy, move nahi).
4. `install-volleyball-clipper-launcher.bat` pe double-click → **DONE**.
   (Ye sirf `asl-vb-clipper://` register karta hai; cricket ka
   `asl-clipper://` waisa hi rehta hai.)

## Har match

1. vMix me **Record** start karo (MP4 — recording likhte-likhte padhi jaati hai).
2. Volleyball panel → **🎬 Clipper** chip → **▶ Start Clipper**.
   Pehli baar Chrome program kholne ka poochega → **Always allow** → **Open**.
3. Pehli baar Setup tab me vMix ka **recording folder** daalo → Save
   (website link panel khud bhar deta hai).
4. **READY** tab dikhta hai jab: Clipper chal raha ho, isi match ke liye set
   ho, vMix recording sach me badh rahi ho, aur website link sahi ho.
5. **Har point = 10 sec ka clip**: point dabane se **7 sec pehle + 3 sec
   baad** (point ke 3 sec baad cut shuru hota hai). Scoring kabhi nahi rukti.
   Numbers `volleyball-clipper-config.json` me `preRollSeconds` /
   `postRollSeconds` se badal sakte ho (cricket ke numbers alag hain).
6. "Who earned this point?" me player chuno → clip usi player (playerId) se
   link hoti hai: `VolleyballClips/<Tournament>/<Match>/Set-1/S1-P027_15-12_PUN_Kill_7-Arjun-Kumar.mp4`
   + `Players/<Team>/<7-Arjun-Kumar>/Set-1/` (hard link) + `metadata/<clipId>.json`.
7. Net nahi hai? Clip phir bhi cut aur save hoti hai; net aate hi ek hi baar
   upload (`/api/volleyball/clips/ingest`).
8. Match ke baad: panel me **Stop clipping** (clipping band) — aur chaho to
   Clipper ke "First time on this PC…" hisse me **Quit the Volleyball Clipper
   on this PC** (program band). Quit sirf `VolleyballClipper.exe` ko band
   karta hai — cricket Clipper, vMix ya koi aur ffmpeg nahi.

## Kuch gadbad ho to

- `volleyball-clipper-log.txt` (isi folder me) — Clipper ne jo likha sab wahan.
- Folder badla? `install-volleyball-clipper-launcher.bat` dobara chalao.
- Hatana ho: `uninstall-volleyball-clipper-launcher.bat` (cricket ka nahi hatta).

## Developer notes

- Entry: `volleyball-clipper-server.js`; apni copies: `vb-fmp4.js`
  (fragmented-MP4 index), `vb-organizer.js` (folders / filenames). Koi cricket
  file `require` nahi hoti — ek sport ka code badalne se doosre ka nahi badalta.
- API (localhost:5007): `GET /status` (`app: "volleyball-clipper"`),
  `GET/POST /setup`, `POST /recording-start`, `POST /clip` (sirf
  `sport: "volleyball"` — cricket press 400 se mana), `POST /clip-meta`,
  `POST /clip-retry`, `GET /clip-jobs`, `POST /sync-now`, `POST /quit`
  (khud band: timers, apne ffmpeg, port; queue pehle save).
- Tests: `test/volleyball/clipper-helper.test.js` (asli Volleyball Clipper +
  badhti hui ffmpeg recording, frame-timecode se 7 s + 3 s),
  `test/volleyball/clipper-separation.test.js` (cricket + volleyball ek saath,
  start/stop cycles, ek doosre par asar nahi).
