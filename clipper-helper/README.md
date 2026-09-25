# Clipper Helper v5.0 — Setup (one-time, operator ka apna PC)

Ye chhota program (`ClipperHelper.exe`) vMix ke saath usi PC par chalta hai
jahan match record ho raha hai. Isi ke wajah se panel me FOUR/SIX/WICKET
(aur Wide 4/6, No-ball 4/6, Leg-bye 4, manual trigger) dabane par clip
apne aap **local recording se hi** cut hoke website/Drive ko bhej di jaati hai.

**v5.0 me kya badla — INTERNET KE BINA BHI CLIP BANTI HAI (offline-first):**

- **Net band ho to bhi clip cut hoti hai.** Pehle FOUR/SIX/boundary ki
  automatic clip ka request panel ke us code se jaata tha jo website ka
  socket disconnect hote hi `return` kar deta tha — matlab net jaate hi
  woh clips maangi hi nahi jaati thi. Ab clip ka trigger website se
  bilkul alag hai: panel → `localhost:5005` → vMix recording → ffmpeg.
  Net ka kaam sirf upload me hai.
- **Do alag stage:** (A) local clip — cut, naam, folder, metadata; ye
  100% offline chalta hai. (B) cloud sync — R2 → Drive → website. Stage B
  kabhi Stage A ki shart nahi hai.
- **Clip kabhi "FAILED" nahi dikhayi jaati** sirf isliye ki net nahi tha.
  Status ab: `CLIP SAVED LOCALLY` → `UPLOAD PENDING - OFFLINE` →
  (net aane par) `UPLOADING TO R2` → `R2 COMPLETE` → `DRIVE COMPLETE` →
  `UPDATING WEBSITE` → `SYNC COMPLETE`. Purana build 60 koshish ke baad
  clip ko hamesha ke liye FAILED maan leta tha — 3-4 ghante net na hone par
  theek-thaak clips permanently chhoot jaati thi. Ab local file jab tak
  disk par hai, retry chalta rehta hai (max 5 min gap).
- **Net wapas aaya = khud-ba-khud sync.** Helper har 10 second me ek chhoti
  si request (`/api/ping`) se check karta hai. Net band hai to sirf wahi ek
  request — R2/Drive par koi bekaar upload nahi. Net aate hi saari pending
  clips apne aap, ek-ek karke (2 parallel) upload hoti hain. Operator ko
  clip dobara cut karne ki zaroorat nahi.
- **Jahan atka tha, wahin se aage:** R2 ho gaya aur Drive reh gaya to sirf
  Drive retry hota hai — R2 dobara upload NAHI hota. Website update reh
  gaya to sirf wahi. Ek clip ka R2 object, Drive file aur website record
  hamesha ek hi `clipId` par — duplicate kabhi nahi.
- **Restart-proof:** app ya laptop restart ho jaaye to jo clip pehle se cut
  ho chuki hai wo **dobara cut nahi hoti** — wahi file use hoti hai aur sync
  wahin se aage badhta hai (queue `clip-jobs.json` me disk par hai).
- **Clips ab folder-wise organize hoti hain** (Master Recording ke bagal me,
  bina internet):

```
MATCH RECORDING FOLDER/
├── match-recording.mp4            ← vMix ki master recording
└── Clips/
    └── <Tournament>/<Teams_MatchId>/
        ├── Highlights/  4/ 6/ Wickets/ Wide-4/ Wide-6/
        │                No-Ball-4/ No-Ball-6/ Bye-4/ Leg-Bye-4/
        ├── Normal/                 ← "Add to Highlights? NO" wali clips
        ├── Batsmen/<Player-Name>/<1st-Innings>/
        ├── Bowlers/<Player-Name>/<1st-Innings>/
        └── metadata/<clipId>.json  ← ball, event, asli player IDs
```

  Filename me poora ball hota hai:
  `08.4_SIX_Rohit-Sharma_vs_Jasprit-Bumrah.mp4` (0.6 ko galti se 1.0 nahi
  banaya jaata — jo ball scoring engine me hai, wahi naam me hai).
  **Disk waste nahi hota:** ffmpeg ek hi baar chalta hai; batsman/bowler
  folder me usi file ke *hard link* hote hain (ek 20-sec MP4, teen jagah
  se khulta hai). Player folder me `player.json` bhi hota hai jisme asli
  `playerId` hai — clip kabhi folder ke naam se match nahi ki jaati.
- **Clip window ab 15 sec pehle + 5 sec baad = 20 sec** (`config.json` me
  `preRollSeconds` / `postRollSeconds` se badal sakte ho).
- **Nayi file:** `clipOrganizer.js` — ise `server.js` aur `fmp4.js` ke saath
  hi rakhna hai (`npm run build` khud exe me daal deta hai).

**v4.2 me kya badla (lambe match ka asli root cause):**
- **Recording kitni bhi lambi ho, clip ki speed same:** pehle har 5 sec me aur har clip
  par ffmpeg poori recording ke saare fragments padhta tha (3 ghante par ek clip ke liye
  ~190 MB disk read, 7 ghante par ~450 MB+). Match lamba hote hi probe timeout hota,
  recording ki length purani ho jaati aur clips fail hone lagte. Ab helper recording ka
  apna chhota index rakhta hai (sirf naya likha hissa padhta hai, ~1 ms) aur clip ke
  liye sirf uske aas-paas ka ~5–10 MB copy karke cut karta hai. **Nayi file:** `fmp4.js`
  (`server.js` ke saath hi rakhni hai; `npm run build` use exe me daal deta hai).
- **Temporary gadbad par jaldi haar nahi:** clip cut ~2 minute tak 6 baar retry hota hai.
- **vMix ne beech me nayi file shuru ki:** clip dono files se jod kar banta hai.
- **Chhote, tez clips:** ≤1080p aur bitrate limit — 18 sec ≈ 10–15 MB (upload + play fast).
- Website URL / match id na ho to upload attempts barbaad nahi hote (30 sec me dobara check).

**v4 me kya badla (10–12 clips ke baad clips miss hona / "fetching" error / restart ki zaroorat — root cause fix):**
- **HIGHLIGHTS button:** ball khelte hi panel me **🎬 HIGHLIGHTS** (ya keyboard `H`) dabao.
  Press ka exact time save hota hai, **5 second** wait hota hai, phir vMix recording se
  **15 sec pehle → 5 sec baad = 20 sec** ki clip cut hoti hai.
- **Har clip ka apna time:** pehle "file ke aakhri 19 second" cut hote the — queue me
  ruki clip galat moment ki ban jaati thi. Ab har press ka apna fixed time hai, isliye
  back-to-back presses bhi sahi aur poore 18 sec ke aate hain.
- **Koi press miss nahi:** pehle 2 second ke andar same type ki doosri press "duplicate"
  maan kar chhod di jaati thi. Ab har press alag clip hai.
- **Ek kharab clip queue nahi rokti:** atka ffmpeg kill hota hai, fail clip baad me
  dobara try hoti hai (queue ke peeche se), agli clips chalti rehti hain.
- **Upload poora hota hai:** pehle upload ko sirf 20 sec milte the — badi clip kabhi
  upload hi nahi hoti thi. Ab upload tab tak chalta hai jab tak data ja raha hai, fail
  hone par ghanton tak khud retry karta hai, aur helper restart ke baad bhi resume
  hota hai. Clip hamesha pehle local folder me save hoti hai.
- **Restart ke baad bhi kaam:** "Start Recording" dobara dabane ki zaroorat nahi.
  Jo recording file vMix abhi likh raha hai, wahi use hoti hai (naya timestamped
  file bhi apne aap pakda jaata hai).
- Panel me har clip ka live status: ⏳ wait → ✂️ cutting → 💾 local → R2 → Drive → website.
- Ball ka outcome daalte hi clip us ball se link hoti hai. 4 / 6 / Wicket / Wide 4 /
  No-ball 4-6 / Bye 4 / Leg-bye 4 apne aap Highlights me jaate hain; baaki par panel
  poochta hai **"Add this clip to Highlights? YES / NO"** (keyboard `Y` / `N`).

⚠️ **vMix recording format:** clips recording chalte-chalte cut hoti hain, isliye vMix ko
aisa format likhna chahiye jo recording ke dauraan padha ja sake (vMix ka **MP4** jo
ab tak kaam kar raha tha, wahi rakho). Agar Setup page par
"recording is not readable while vMix is recording" dikhe, to vMix Settings →
Recording me format badlo.

**Koi Google service account / JSON key / Cloud Console NAHI chahiye.**
Bas panel ke "Connect Google Drive" button se sign-in karna hai — 2 click.

⚠️ **Agar tumhare paas sirf `server.js` + `package.json` + `ffmpeg.exe` hain
(purana `ClipperHelper.exe` is update se pehle ka hai), pehle naya `.exe`
banao:**
```
npm install
npm run build
```
Isse naya `ClipperHelper.exe` isi folder me ban jayega — wahi use karo.

---

## Step 1 — Folder banao
Apne PC par kahin bhi ek folder banao, jaise `C:\ClipperHelper\`.
Us folder ke andar ye files rakho (jo tumhe di gayi hain):
- `ClipperHelper.exe`
- `ffmpeg.exe` ⚠️ **isi folder mein, `ClipperHelper.exe` ke bilkul saath** — iske bina exe khulte hi band ho jayega (black screen aake gayab).
- `config.json`

## Step 2 — Setup page se 2 cheez bharo (Notepad/JSON nahi chahiye)
`config.json` ab haath se edit karne ki zaroorat nahi hai. Pehli baar
`ClipperHelper.exe` chalate hi ek **Setup page** apne aap browser me
khul jayega jisme sirf 2 box hain:

- **vMix Recording File** — vMix jis file me record kar raha hai, uska
  poora path (ya sirf us folder ka path — jo file abhi record ho rahi hai wo apne aap mil jaati hai) (jaise `C:\Users\YOUR_NAME\Videos\match-recording.mp4`).
  ⚠️ vMix Settings → Recording me jaake **"Add Timestamp to Filename" OFF**
  kar do aur ek fixed file name set karo — warna har match par naya naam
  banega aur helper ko file nahi milegi.
- **Website URL** — apni website ka address (jaise `https://yourscoreapp.onrender.com`),
  wahi jo panel browser me khulta hai. Isi address par clip bhejkar helper
  Cloudflare R2 + Drive dono me upload karwata hai aur player se link karwata
  hai (taaki scorecard me player ke naam ke saamne clip dikhe).
  ⚠️ Panel har baar "Start Recording" dabane par ye address khud-ba-khud
  bhi bhej deta hai, to ye field bas backup ke taur par hai — phir bhi sahi
  bhar dena.

Dono box bharo, **💾 Save** dabao — ho gaya, is tab ko band kar sakte ho.
(Agar page apne aap na khule, browser me khud jaake
`http://localhost:5005/setup` khol lo — same cheez hai.)

## Step 3 — Har match se pehle `ClipperHelper.exe` double-click karo
Ek black window khulegi jisme likha aayega:
```
🎥 Clipper Helper running at http://localhost:5005
👉 Setup page (no more editing config.json by hand): http://localhost:5005/setup
Keep this window open during the match.
```
Ye window match khatam hone tak khuli rakhni hai (minimize kar sakte ho, band mat karo).
Ek baar Setup save ho jaaye to agli baar exe chalane par yeh page khud nahi khulega — seedha kaam shuru ho jayega. Kabhi bhi dobara details badalni ho to `http://localhost:5005/setup` khol lo.

⚠️ Windows Defender/SmartScreen pehli baar "Unknown publisher" warning de
sakta hai — **"More info" → "Run anyway"** dabake chala sakte ho, ye safe hai.

## Step 4 — Match ke dauraan operator kya kare
1. `ClipperHelper.exe` double-click karke window khuli rakho.
2. vMix me Recording **Start** dabao.
3. Website ke panel me **🔗 Connect Google Drive** button dabao — Google
   sign-in popup aayega, apna account select karo, phir jo folder me clips
   chahiye wo folder choose (ya naya banao) karo. Bas — kahi bhi kuch paste
   nahi karna, koi email share nahi karna.
4. Panel me **🔴 Start Recording** dabao.
5. Match chalao — jab bhi FOUR / SIX / WICKET dabaoge, clip cut hoke seedha
   tumhari website ko bhej di jayegi, jo use Cloudflare R2 + Drive dono me
   upload karke us over/ball ke asli batter-bowler se link kar degi — isi
   wajah se scorecard me player ke naam ke saamne clip dikhti hai.
   (Net down ho to bhi sab kuch chalta hai: clip cut hoti hai, sahi folder
   me sahi naam se save hoti hai, aur queue me `UPLOAD PENDING - OFFLINE`
   dikhati hai. Net aate hi khud-ba-khud R2 + Drive + website par chali
   jaati hai — usi over/ball/batsman/bowler par. Ek clip kabhi do baar
   upload nahi hoti, aur restart ke baad dobara cut bhi nahi hoti.)

---

### Kuch dhyan rakhne wali baatein
- Google sign-in ~1 ghante tak valid rehta hai, panel usay khud-ba-khud
  refresh karta rehta hai jab tak browser tab khula hai. Agar lamba match
  chala aur uploads ruk jaayein, bas "Connect Google Drive" dobara dabao.
- Helper window band ho gayi to naye clips nahi banenge — vMix recording
  par koi asar nahi padega, bas clips ruk jayengi jab tak helper dobara na chale.
- Agar pehli baar `ClipperHelper.exe` chalate hi band ho jaaye, matlab
  `config.json` nahi tha — helper ne khud ek blank bana diya hoga, use edit
  karke phir se .exe chalao.
- Agar "recording file not found" jaisa error dikhe, matlab `config.json`
  ka path galat hai ya vMix ne abhi file banayi nahi.
- `http://localhost:5005/status` browser me khol ke kabhi bhi check kar
  sakte ho ki helper ko Drive folder pata hai ya nahi.
