# Clipper Helper v4 — Setup (one-time, operator ka apna PC)

Ye chhota program (`ClipperHelper.exe`) vMix ke saath usi PC par chalta hai
jahan match record ho raha hai. Isi ke wajah se panel me FOUR/SIX/WICKET
(aur Wide 4/6, No-ball 4/6, Leg-bye 4, manual trigger) dabane par clip
apne aap **local recording se hi** cut hoke website/Drive ko bhej di jaati hai.

**v4 me kya badla (10–12 clips ke baad clips miss hona / "fetching" error / restart ki zaroorat — root cause fix):**
- **HIGHLIGHTS button:** ball khelte hi panel me **🎬 HIGHLIGHTS** (ya keyboard `H`) dabao.
  Press ka exact time save hota hai, **3 second** wait hota hai, phir vMix recording se
  **15 sec pehle → 3 sec baad = 18 sec** ki clip cut hoti hai.
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
- Panel me har clip ka live status: ⏳ 3 sec wait → ✂️ cutting → 💾 local → R2 → Drive.
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
   (Agar website tak pahunch na ho paye — jaise net down — clip local folder
   me safe rehti hai aur helper khud baar-baar upload try karta rehta hai;
   net aate hi upload ho jaati hai. Ek clip kabhi do baar upload nahi hoti.)

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
