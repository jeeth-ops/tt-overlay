# Kaise check karein — Stream Engine capture / timing

Ye sab aapke match PC pe hi check ho sakta hai (is cloud container me ffmpeg,
capture card aur GPU nahi hai, isliye maine picture khud verify nahi kiya).

---

## 0. Pehle: sahi script se start karo

**`stream-engine\start-native.bat`** se start karo — `start.bat` se nahi.

Wajah: naye rows (Program feed, CAPTURE CHECK) sirf **native program feed**
mode me aate hain, aur wo flag sirf `start-native.bat` set karta hai
(`set NATIVE_PROGRAM_FEED=true`). `start.bat` se chalane pe wo rows `—`
dikhenge — wo bug nahi hai.

Black window me ye lines dhundo:

```
[compositor] camera offers N mode(s): 1920x1080@60 raw, 1280x720@60 raw, ...
[compositor] camera mode auto-detected: 1920x1080@50 (raw)
```

Pehli line aapke AVMATRIX card ne jo bataya wo hai. Doosri line jo maanga
gaya wo hai. Agar `⚠ CAPTURE RATE MISMATCH` dikhe to wahi seedha jawab hai.

---

## 1. Panel 3 me mode chuno

🎬 **Live Studio** card me:

- **Resolution** → `1920×1080` (ya `720×480 (4:3 SD)`)
- **Video Mode** → `25p` / `50p` / `50i → 50p`
  - 720×480 chunne pe list khud badalkar sirf `25p` dikhayegi. Ye jaan-boojh
    kar hai, bug nahi.

Neeche turant ek line aayegi — ye **device se pucha gaya** jawab hai:

| Line | Matlab | Kya karein |
|---|---|---|
| `✓ 50p: The device reports 50 fps as a fixed mode.` | card ne pakka mode bataya | aage badho |
| `⚠ 50p: The device advertises 5–60 fps as a range…` | card "haan" bolega par guarantee nahi — jo camera bhejega wahi pass karega | step 3 ka CAPTURE CHECK dekhna zaroori |
| `✗ 50p is not available on this device. It offers: …` | card ye mode deta hi nahi | usme se jo listed hai wo chuno |

Ye teen alag jawab hain — `range` ko maine jaan-boojh kar green tick nahi
banaya, kyunki wahi AVMATRIX behaviour hai jisse galat speed aa rahi thi.

---

## 2. Recording start karo (1 minute)

🎬 **Match Recording** → 🔴 Start Recording. Fir ~30 second ruko.

---

## 3. Panel me 4 rows padho

### 🎬 Match Recording card me

| Row | Sahi | Galat |
|---|---|---|
| **FPS (req/actual)** | `50 / 50.0 (1.00× real time)` hara | `50 / 25.0 (0.50×) ⚠ PLAYS FAST` laal |
| **Program feed** | jo select kiya wahi, jaise `1920×1080 • 50 FPS` | amber, aur bracket me asli rate |
| **Master file** | `one continuous recording` hara | `N parts` — tooltip me har part ki wajah |

`FPS (req/actual)` me `1.00×` ka matlab: **1 asli second = 1 recorded
second.** `0.50×` ka matlab file aadhi lambi hai, matlab double speed.

### 🎬 Live Studio card me (neeche, recording/preview chalu hone pe)

```
CAPTURE        1920×1080 @ 50p
PROGRAM        1920×1080 @ 50p
RECORDING      1920×1080 @ 50p
STREAM         1920×1080 @ 50p
CAPTURE CHECK  ✓ MATCHED (50.0 fps)
```

720×480 chuna ho to CAPTURE badi rahegi aur PROGRAM chhoti — **ye sahi hai**:

```
CAPTURE        1920×1080 @ 25p     ← card apne native mode pe
PROGRAM        720×480 @ 25p       ← downscale compositor me
```

Card ko 720×480 pe force karna hi wo bug tha jo maine theek kiya.

`⚠ MISMATCH — asked 50, getting 25` aaye to wo **asli rate** bata raha hai:
card 50 nahi de raha. Us number wale mode pe switch karo.

---

## 4. Recording ki duration check karo (sabse pakka test)

Stop Recording dabao, fir file dekho:

```
stream-engine\StreamEngineData\Recordings\<matchId>\master.mp4
```

**File Explorer** me us file pe right-click → Properties → Details →
**Length**. Ya VLC me kholo.

- 1 minute record kiya → Length ~**1:00** hona chahiye ✅
- Length ~**0:30** aaya → double speed ❌ (FPS row bhi PLAYS FAST bolegi)

Ye ek check sabse zyada bharosemand hai, kyunki isme koi panel ya reading
beech me nahi hai — bas file kitni lambi hai.

---

## 5. Offline test (internet wala fix)

1. Recording + scoring + clips chalu rakho
2. **LAN cable nikal do / Wi-Fi off** — 10 minute
3. Is dauran: 2–3 clip banao, kuch balls score karo
4. Cable wapas lagao
5. Stop Recording

Fir check:

| Kya | Sahi |
|---|---|
| **Master file** row | `one continuous recording`, ya `✓ one master (master_complete.mp4, from N parts)` |
| part boundaries (tooltip) | koi bhi `[remote]` **nahi** hona chahiye |
| clips | local folder me maujood, R2/Drive `PENDING` → internet aane pe apne aap upload |
| recording | beech me ruki nahi honi chahiye |

Agar koi boundary `[remote]` bole, ya console me
`⛔ ARCHITECTURE VIOLATION` dikhe — wo asli architecture bug hai, wahi line
mujhe bhej dena.

**Ek baat pehle se bata deta hoon:** offline hone pe **overlay ka score
freeze ho jayega** aur scoring enter nahi hogi. Wo abhi theek nahi hai —
overlay aur scoring dono internet (Render) se chalte hain. Wo alag kaam hai
(`STREAM-ENGINE-AUDIT.md` §I3). Video recording chalti rahegi.

---

## 6. Chaaron profile ka test

Har ek pe: select → CAPTURE CHECK dekho → 1 min record → duration check.

| Profile | CAPTURE CHECK | Duration |
|---|---|---|
| 1920×1080 / 25p | | |
| 1920×1080 / 50p | | |
| 1920×1080 / 50i | | |
| 720×480 / 25p | | |

---

## 7. Mujhe kya bhejna

Kuch galat lage to:

1. **Panel ka screenshot** — Match Recording + Live Studio dono cards
2. **Black console window ka screenshot** — khaas taur pe `[compositor]` lines
3. **`recording-session.json`** — `StreamEngineData\Recordings\<matchId>\` me.
   Isme har part ki wajah likhi hai, classified `local`/`remote`. Master 2
   parts me kyun bana — iska seedha jawab isi file me hai.
4. master.mp4 ki **Length** aur aapne kitni der record kiya

In chaar cheezon se main exact wajah nikaal sakta hoon, guess kiye bina.

---

## Bonus: test khud chala ke dekho

```
cd stream-engine
node test\captureTarget.test.js
node test\timebaseMonitor.test.js
node test\recordingSession.test.js
node test\programFps.test.js
node test\captureModes.test.js
node test\localIsolation.test.js
```

Ye 91 test hain (8 suites). Camera ki zaroorat nahi — logic check karte hain.
Sab `passed, 0 failed` aana chahiye.
