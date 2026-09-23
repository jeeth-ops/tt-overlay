# Clipper Helper v3 — Setup (one-time, operator ka apna PC)

Ye chhota program (`ClipperHelper.exe`) vMix ke saath usi PC par chalta hai
jahan match record ho raha hai. Isi ke wajah se panel me FOUR/SIX/WICKET
(aur Wide 4/6, No-ball 4/6, Leg-bye 4, manual trigger) dabane par clip
apne aap **local recording se hi** cut hoke website/Drive ko bhej di jaati hai.

**v3 me kya badla:**
- Har clip ab poora **18 second** ka hai: trigger se **15 sec pehle** +
  **3 sec baad** ka footage — pehle 20s (10/10) tha.
- Cutting ab **poori tarah local** hai — kisi bhi network/website call se
  kabhi block nahi hoti. Pehle agar website slow/down ho jaati thi to
  poora Clipper beech match me "fetching…" me atak jaata tha aur uske
  baad clips cutna band ho jaati thi. Ab cutting aur uploading do alag,
  independent queues hain — upload kitna bhi atka rahe, agla clip cutna
  kabhi nahi rukta.
- Har clip cut hone ke baad **validate** hoti hai (file size, ~18s
  duration) — kuch galat mile to khud retry karta hai.
- Clips Folder set nahi kiya to ab clips **recording wale folder ke andar
  `Clips\` mein** save hoti hain (pehle .exe ke apne folder me jaati thi).

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
  poora path (jaise `C:\Users\YOUR_NAME\Videos\match-recording.mp4`).
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
   (Agar website tak pahunch na ho paye — jaise net down — to purana
   fallback chalta hai: clip seedha Drive me jaati hai, bas player-linking
   aur R2 us waqt skip ho jaati hai.)

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
