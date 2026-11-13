# 🎾 Tennis Clipper v1.0 — Setup (one-time, vMix wale PC pe)

Ye **sirf TENNIS** (lawn tennis) ka Clipper hai — ek alag program. Cricket ka
Clipper (`clipper-helper/`, `ClipperHelper.exe`) aur Volleyball ka Clipper
(`volleyball-clipper-helper/`, `VolleyballClipper.exe`) isse bilkul alag hain:
teeno ka program, port, Start/Stop link, settings, clip queue, clips folder aur
log alag hain, isliye tennis install / build / start / stop karne se cricket ya
volleyball par koi asar nahi padta (aur ulta bhi nahi).

|                    | 🏏 Cricket Clipper            | 🏐 Volleyball Clipper                    | 🎾 Tennis Clipper (ye)               |
| ------------------ | ----------------------------- | ---------------------------------------- | ------------------------------------ |
| Program            | `ClipperHelper.exe`           | `VolleyballClipper.exe`                  | `TennisClipper.exe`                  |
| Port               | `localhost:5005`              | `localhost:5007`                         | `localhost:5009`                     |
| Start/Stop link    | `asl-clipper://`              | `asl-vb-clipper://`                      | `asl-tn-clipper://`                  |
| Launcher           | `clipper-launch.vbs`          | `volleyball-clipper-launch.vbs`          | `tennis-clipper-launch.vbs`          |
| Install BAT        | `install-clipper-launcher.bat`| `install-volleyball-clipper-launcher.bat`| `install-tennis-clipper-launcher.bat`|
| Settings           | `config.json`                 | `volleyball-clipper-config.json`         | `tennis-clipper-config.json`         |
| Clip queue         | `clip-jobs.json`              | `volleyball-clip-jobs.json`              | `tennis-clip-jobs.json`              |
| Clips folder       | `<recording>\Clips`           | `<recording>\VolleyballClips`            | `<recording>\TennisClips`            |
| Log                | `clipper-log.txt`             | `volleyball-clipper-log.txt`             | `tennis-clipper-log.txt`             |
| Website ingest     | `/api/clips/ingest`           | `/api/volleyball/clips/ingest`           | `/api/tennis/clips/ingest`           |
| Stop kya band karta hai | sirf `ClipperHelper.exe` | sirf `VolleyballClipper.exe`           | sirf `TennisClipper.exe` (+ uska ffmpeg) |

> ⚠️ Tennis Clipper ko **apne alag folder** me rakho (jaise
> `C:\AllSportsLive\TennisClipper`). Cricket ya volleyball ke Clipper folder me
> tennis ki files mat daalo. Tennis ka install BAT ya `npm run build` un
> folders me chalaoge to wo khud mana kar denge (kuch nahi badlega).

## Ek baar (har PC pe)

1. Is folder (`tennis-clipper-helper/`) ki saari files ek **naye folder** me
   rakho.
2. Us folder me Command Prompt kholo:
   ```
   npm install
   npm run build
   ```
   → `TennisClipper.exe` ban jayega (cricket ya volleyball ke exe ko chhuta
   bhi nahi). `pkg` chahiye (`npm i -g pkg`) — wahi jo baaki builds me lagta hai.
3. `ffmpeg.exe` isi folder me rakho (doosre Clipper folder wala `ffmpeg.exe`
   copy kar sakte ho — copy, move nahi).
4. Website se **Tennis Clipper Launcher** (`/tennis-clipper-launcher.zip`)
   lo, isi folder me unzip karo, `install-tennis-clipper-launcher.bat` pe
   double-click → **DONE**. (Ye sirf `asl-tn-clipper://` register karta hai;
   `asl-clipper://` aur `asl-vb-clipper://` waise hi rehte hain.)

## Har match

1. vMix me **Record** start karo (MP4 — recording likhte-likhte padhi jaati hai).
2. Tennis panel → **Clips** tab → **▶ Start Clipper** (ya vMix PC pe
   `/tennis-clipper?match=…` wala Clipper page, jab scoring phone remote se
   ho rahi ho). Pehli baar Chrome program kholne ka poochega → **Always allow**
   → **Open**.
3. Pehli baar Setup tab me vMix ka **recording folder** daalo → Save (website
   link panel khud bhar deta hai).
4. **READY** tab dikhta hai jab: Clipper chal raha ho, isi match ke liye set
   ho, vMix recording sach me badh rahi ho, aur website link sahi ho.
5. **Har point = ek clip**: point dabane se **7 sec pehle + 3 sec baad**
   (default; point ke 3 sec baad cut shuru hota hai). Scoring kabhi nahi rukti.
   Tournament ki apni window (dashboard → tournament → Edit → "Seconds before
   / after the press", 1–30 s pehle, 1–15 s baad) uske har naye match me aati
   hai, har press ke saath Clipper tak jaati hai aur wahi chalti hai;
   `tennis-clipper-config.json` ke `preRollSeconds` / `postRollSeconds` sirf
   is PC ke default hain.
6. Clip apne point ke saath file hoti hai:
   `TennisClips/<Tournament>/<Match>/Set-1/Game-05/S1-G05-P031_2-2_40-15_Alcaraz_Ace.mp4`
   + `Players/<Side>/<Player>/Set-1/` (hard link — ace, winner, point jeetne
   wale; double fault karne wale ke folder me nahi) + `metadata/<clipId>.json`.
   Point baad me badla (ace tha, winner tha, undo hua)? Wahi file rename /
   re-link hoti hai — dobara cut nahi.
7. Haath se clip (celebration, do points ke beech ka moment — panel ya phone
   remote se): `Set-N/Moments/` me.
8. Net nahi hai? Clip phir bhi cut aur save hoti hai; net aate hi ek hi baar
   upload (`/api/tennis/clips/ingest`).
9. Match ke baad: panel me **Stop clipping** — aur chaho to **Quit the Tennis
   Clipper on this PC** (program band). Quit sirf `TennisClipper.exe` ko band
   karta hai — cricket / volleyball Clipper, vMix ya koi aur ffmpeg nahi.

## Kuch gadbad ho to

- `tennis-clipper-log.txt` (isi folder me) — Clipper ne jo likha sab wahan.
- Folder badla? `install-tennis-clipper-launcher.bat` dobara chalao.
- Hatana ho: `uninstall-tennis-clipper-launcher.bat` (cricket / volleyball ka
  nahi hatta).

## Developer notes

- Entry: `tennis-clipper-server.js`; apni copies: `tn-fmp4.js`
  (fragmented-MP4 index — volleyball ke `vb-fmp4.js` jaisa), `tn-organizer.js`
  (folders / filenames: set → game → point). Koi cricket ya volleyball file
  `require` nahi hoti — ek sport ka code badalne se doosre ka nahi badalta.
- API (localhost:5009): `GET /status` (`app: "tennis-clipper"`, `tennis: true`,
  `tennisClipTiming`), `GET/POST /setup`, `POST /recording-start` (sirf
  `sport: "tennis"`), `POST /clip` (sirf `sport: "tennis"` — point:
  `<matchId>_<eventId>`, haath se: `<matchId>_clip-<id>`; cricket /
  volleyball press 400 se mana), `POST /clip-meta`, `POST /clip-retry`,
  `GET /clip-jobs`, `POST /sync-now`, `POST /quit` (khud band: timers, apne
  ffmpeg, port; queue pehle save).
- Upload: `POST /api/tennis/clips/ingest?matchId=…&clipId=…&timestamp=…` with
  ONE header, `X-Point-Meta` (numbers, ids, match ka clip token
  `tnClipToken`, recording ka file NAME — kabhi local path nahi).
- Tests: `test/tennis/clipper-helper.test.js` (asli Tennis Clipper + badhti
  hui ffmpeg recording, frame-timecode se window; offline; restart; dusre
  sports ke press mana).
